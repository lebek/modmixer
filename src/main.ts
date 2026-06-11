// MUST be the first import: installs uncaughtException/unhandledRejection
// handlers before any other module body runs. Catches startup crashes that
// happen during bundled require() — too early for initSentry() to help.
import { SMOKE_TEST } from './agent/early-error.js';
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  MenuItem,
  nativeImage,
  nativeTheme,
} from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { initSentry } from './agent/sentry.js';

// Initialize Sentry as early as possible so any failure during app
// construction is reported. Must run before AgentHost imports do anything
// non-trivial (pi-mono touches the network).
initSentry();

import { AgentHost } from './agent/agent-host.js';
import {
  hasCurrentConsent,
  loadSettings,
  resetOnboarding,
} from './agent/settings.js';
import { setRimWorldInstallOverride } from './agent/paths.js';
import {
  initTelemetry,
  shutdownTelemetry,
  track,
} from './agent/telemetry.js';
import { onModChanged } from './agent/mod-events.js';
import {
  analyzeSnapshot,
  getRegistry,
  getSessionManager,
  getCommunityRules,
} from './agent/registry/index.js';
import { getMonitorServer } from './agent/monitor/server.js';
import type {
  BridgeMessage,
  MonitorConnectionState,
} from './agent/monitor/protocol.js';
import { onAssetsChanged, stopAllWatches } from './agent/assets/watcher.js';
import {
  onPublishProgress,
  type PublishProgressEvent,
} from './agent/workshop.js';
import {
  CONFIRM_CHANNEL_RESOLVE,
  initConfirmationGate,
} from './agent/security/confirmation-gate.js';
import {
  cancelActiveRebuild,
  ensureIndexAtStartup,
  pipeProgressToWindow,
} from './agent/index/main-bridge.js';
import { closeIndexDb } from './agent/index/db.js';
import { initUpdater } from './agent/updater.js';
import { syncCommunityLore } from './agent/community-lore-sync.js';
import type { RegistryEnvelope, RouteContext } from './main/routes/context.js';
import { registerLifecycleRoutes } from './main/routes/lifecycle.js';
import { registerSettingsRoutes } from './main/routes/settings.js';
import { registerConversationRoutes } from './main/routes/conversations.js';
import { registerModRoutes } from './main/routes/mods.js';
import { registerRegistryRoutes } from './main/routes/registry-routes.js';
import { registerAssetsRoutes } from './main/routes/assets.js';
import { registerAttachmentRoutes } from './main/routes/attachments.js';
import { registerSnapshotsRoutes } from './main/routes/snapshots.js';
import { registerSystemRoutes } from './main/routes/system.js';
import { registerLiveRoutes } from './main/routes/live.js';
import {
  installAssetProtocolHandler,
  registerAssetSchemeAsPrivileged,
} from './main/asset-protocol.js';
import { approveQuit, isQuitApproved } from './main/quit-guard.js';

if (started) {
  app.quit();
}

// Privileged-scheme registration must happen synchronously before `app.ready`
// so the renderer can use `modmixer-asset://` URLs in <img src>.
registerAssetSchemeAsPrivileged();

// Single-instance lock: a second launch (Start Menu re-click, second `npm start`,
// Squirrel post-install autolaunch racing the first run) should focus the
// existing window instead of spinning up a parallel main + renderer + GPU +
// utility process tree that ends up fighting over %APPDATA%/Modmixer (cache
// lock errors, duplicate index DBs, leaked processes).
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// In dev the app name comes from Electron's defaults (which says "Electron")
// rather than package.json's productName. Force it so the dock tooltip,
// About menu, and userData paths match the packaged app.
app.setName('Modmixer');

// Demo-video harness (dev-only; driven externally from ~/projects/modmixer-demo).
// MODMIXER_DEMO=1 opens a CDP port so the harness can drive the renderer, and
// reshapes the window (createWindow below) for clean capture. Inert otherwise.
const DEMO_MODE = process.env.MODMIXER_DEMO === '1';
if (DEMO_MODE) {
  app.commandLine.appendSwitch(
    'remote-debugging-port',
    process.env.MODMIXER_DEMO_CDP ?? '9223',
  );
  // Optional supersampling: render at N× device scale so post-production
  // zooms stay sharp (captured frames come out at N× the window size).
  if (process.env.MODMIXER_DEMO_SCALE) {
    app.commandLine.appendSwitch(
      'force-device-scale-factor',
      process.env.MODMIXER_DEMO_SCALE,
    );
  }
}

// Hide the default Electron menu strip on Windows/Linux. The Mac menubar lives
// in the OS chrome so it's free real estate; on other platforms it duplicates
// our in-app navigation and steals vertical space.
if (process.platform !== 'darwin') {
  Menu.setApplicationMenu(null);
}

// CLI escape hatch for development: `--reset-onboarding` wipes the
// onboarding record (and optionally the consent record with `--reset-all`)
// before the app reads settings. This lets you iterate the flow without
// hand-editing settings.json. The flags are no-ops in production builds
// since they only affect persisted user state.
if (process.argv.includes('--reset-onboarding')) {
  try {
    resetOnboarding({ alsoConsent: process.argv.includes('--reset-all') });
    // eslint-disable-next-line no-console
    console.log('[onboarding] reset via --reset-onboarding flag');
  } catch (err) {
    console.error('[onboarding] reset failed:', err);
  }
}

// Seed the install-path override from settings so detectRimWorldPaths()
// honors it from the very first call (registry start, ensureIndexAtStartup,
// bridge install, …). main.ts updates this again when the user picks a folder.
setRimWorldInstallOverride(loadSettings().rimworldInstallOverride);

let mainWindow: BrowserWindow | null = null;
const getWindow = () => mainWindow;

// Auto-update from GitHub releases. No-ops in dev and on unsupported
// platforms; logs but won't throw if the feed is unreachable. Also exposes
// a manual "Check for updates" path the renderer can drive from Settings.
initUpdater(getWindow);

// The confirmation gate must exist before AgentHost wraps tools — the
// wrappers grab `getConfirmationGate()` lazily at execute time, but the
// IPC bridge for resolution events needs to be installed up front.
const confirmGate = initConfirmationGate(() => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const wc = mainWindow.webContents;
  return {
    send(channel, payload) {
      wc.send(channel, payload);
    },
  };
});
ipcMain.on(CONFIRM_CHANNEL_RESOLVE, (_evt, payload: unknown) => {
  confirmGate.resolveFromRenderer(payload);
});
// The window `close` handler defers quitting to the renderer so it can confirm
// with the user when an agent turn is mid-flight (quitting aborts it). The
// renderer calls back here once approved; we mark the quit and re-issue the
// close, which now sails through the guard instead of looping back.
ipcMain.on('modmixer:quit:confirm', () => {
  approveQuit();
  mainWindow?.close();
});
// Apply the persisted "dangerously skip permissions" bypass before the first
// agent turn so it's in force from launch (the setting survives restarts). The
// Advanced-settings toggle keeps the gate in sync live thereafter.
confirmGate.setSkipPermissions(loadSettings().dangerouslySkipPermissions);
const host = new AgentHost(getWindow);
if (DEMO_MODE) {
  // Demo-video harness: one-shot completions on the user's own credentials
  // (powers the stage-1 "user-actor"). Never registered outside demo mode.
  ipcMain.handle(
    'modmixer:demo:complete',
    (_event, args: { modelId: string; system: string; user: string }) =>
      host.demoComplete(args),
  );
}
// Boot the mod registry so it's primed by the time the renderer asks for a
// snapshot. Subscribers (renderer broadcast, agent tools) attach below.
const registry = getRegistry();
void registry.start();
registry.subscribe(() => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(
      'modmixer:registry:changed',
      buildRegistryEnvelope(),
    );
  }
});

// Hydrate any persisted (orphaned) session so the renderer can prompt the
// user to apply or revert. We DON'T auto-revert: the user's bytes are precious.
const sessions = getSessionManager();
sessions.adoptPersisted();
sessions.subscribe(() => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('modmixer:session:changed', sessions.getActive());
  }
});

// Warm the community rules cache in the background — first call kicks off
// the network fetch with a long timeout, fall-back to disk cache if offline.
void getCommunityRules();

function buildRegistryEnvelope(): RegistryEnvelope {
  const snapshot = registry.getSnapshot();
  return { snapshot, analysis: analyzeSnapshot(snapshot) };
}

function requireConsent(): void {
  if (!hasCurrentConsent()) {
    throw new Error(
      'Consent not accepted. The agent is disabled until the user accepts the consent screen.',
    );
  }
}

const routeContext: RouteContext = {
  ipc: ipcMain,
  getWindow,
  host,
  confirmGate,
  buildRegistryEnvelope,
  requireConsent,
};

registerLifecycleRoutes(routeContext);
registerSettingsRoutes(routeContext);
registerConversationRoutes(routeContext);
registerModRoutes(routeContext);
registerRegistryRoutes(routeContext);
registerAssetsRoutes(routeContext);
registerAttachmentRoutes(routeContext);
registerSnapshotsRoutes(routeContext);
registerSystemRoutes(routeContext);
registerLiveRoutes(routeContext);

// Renderer-side broadcasts for events whose handlers can't easily live in
// route modules (they need the live mainWindow ref).
onAssetsChanged((folder) => {
  mainWindow?.webContents.send('modmixer:assets:changed', { folder });
});

onPublishProgress((event: PublishProgressEvent) => {
  mainWindow?.webContents.send('modmixer:workshop:progress', event);
});

onModChanged((folder) => {
  mainWindow?.webContents.send('modmixer:mod:changed', { folder });
});

const monitor = getMonitorServer();
monitor.on('state', (state: MonitorConnectionState) => {
  mainWindow?.webContents.send('modmixer:monitor:state', state);
});
monitor.on('message', (msg: BridgeMessage) => {
  mainWindow?.webContents.send('modmixer:monitor:message', msg);
});

const createWindow = () => {
  // In dev the .icns/.ico baked in by Forge isn't available, so set the
  // icon at runtime so the dock/window match the packaged app.
  const devIconPath = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? path.resolve(__dirname, '../../assets/icon.png')
    : null;
  if (devIconPath && process.platform === 'darwin') {
    app.dock?.setIcon(nativeImage.createFromPath(devIconPath));
  }

  // Match the active theme so the empty window doesn't flash the wrong colour
  // before React paints. "auto" follows OS chrome.
  const themePref = loadSettings().theme;
  const dark =
    themePref === 'dark' ||
    (themePref === 'auto' && nativeTheme.shouldUseDarkColors);
  const bg = dark ? '#131417' : '#f4f4f0';

  // Demo capture wants an exact, chrome-free canvas at a fixed content size;
  // normal runs get the standard framed window.
  const demoSize = DEMO_MODE
    ? (process.env.MODMIXER_DEMO_SIZE ?? '1920x1080').split('x').map(Number)
    : null;

  mainWindow = new BrowserWindow({
    width: demoSize?.[0] || 1280,
    height: demoSize?.[1] || 800,
    ...(demoSize
      ? { frame: false, resizable: false, useContentSize: true }
      : {}),
    backgroundColor: bg,
    icon: devIconPath ?? undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (DEMO_MODE) {
    // Let the harness's injected MediaRecorder capture the app without a
    // source picker: grant getDisplayMedia with our own frame (tab capture —
    // no OS chrome, immune to window occlusion).
    mainWindow.webContents.session.setDisplayMediaRequestHandler(
      (_request, callback) => {
        const frame = mainWindow?.webContents.mainFrame;
        if (frame) callback({ video: frame });
      },
    );
  }

  // Quitting aborts any in-flight agent turn, so defer the close to the
  // renderer, which confirms with the user first (only when a turn is actually
  // running). It calls back via 'modmixer:quit:confirm' to let the close
  // proceed. A crashed/destroyed renderer can't be asked, so we let those
  // through rather than trap the user in an unclosable window.
  mainWindow.on('close', (event) => {
    if (isQuitApproved()) return;
    const wc = mainWindow?.webContents;
    if (!wc || wc.isDestroyed() || wc.isCrashed()) return;
    event.preventDefault();
    wc.send('modmixer:quit:requested');
  });

  // Electron ships the spell-checker (red underlines) but no default context
  // menu, so right-clicking a misspelled word does nothing until we build the
  // menu ourselves from the event params. Covers any editable field, not just
  // the chat box.
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const menu = new Menu();

    for (const suggestion of params.dictionarySuggestions) {
      menu.append(
        new MenuItem({
          label: suggestion,
          click: () => mainWindow?.webContents.replaceMisspelling(suggestion),
        }),
      );
    }

    if (params.misspelledWord) {
      menu.append(
        new MenuItem({
          label: 'Add to dictionary',
          click: () =>
            mainWindow?.webContents.session.addWordToSpellCheckerDictionary(
              params.misspelledWord,
            ),
        }),
      );
      menu.append(new MenuItem({ type: 'separator' }));
    }

    if (params.isEditable) {
      menu.append(
        new MenuItem({ role: 'cut', enabled: params.editFlags.canCut }),
      );
      menu.append(
        new MenuItem({ role: 'copy', enabled: params.editFlags.canCopy }),
      );
      menu.append(
        new MenuItem({ role: 'paste', enabled: params.editFlags.canPaste }),
      );
    } else if (params.editFlags.canCopy) {
      // Non-editable selection (e.g. a model's reply) — still allow copy.
      menu.append(new MenuItem({ role: 'copy' }));
    }

    if (menu.items.length > 0) menu.popup();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

app.on('ready', () => {
  installAssetProtocolHandler();
  initTelemetry();
  track({ name: 'app_started' });
  // safeStorage is only guaranteed available after `ready` on Linux/Windows.
  // The AgentHost constructor ran earlier with an empty cache; refresh it now
  // so previously-stored OAuth creds become visible to the model picker.
  host.primeAfterReady();
  createWindow();
  // Pipe index progress events to the renderer. Subscribed once for the
  // process lifetime — the listener filters by mainWindow internally.
  pipeProgressToWindow(getWindow);
  if (SMOKE_TEST) {
    // CI smoke test: exercises every packaging-time risk in the shipped
    // installer (better-sqlite3, web-tree-sitter + grammar wasm, bundled
    // ripgrep, vendored ilspycmd). See src/agent/smoke-test.ts for the
    // step-by-step rationale.
    void (async () => {
      try {
        const { runSmokeTest } = await import('./agent/smoke-test.js');
        await runSmokeTest();
        app.exit(0);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[smoke-test] failed:', err);
        app.exit(1);
      }
    })();
    return;
  }
  // Kick off the index rebuild if the cache is stale/missing. Fire-and-
  // forget — the renderer modal will surface progress as it streams in.
  void ensureIndexAtStartup();
  // Push local lore, pull curated community lore. No-op if the toggle is
  // off; errors are logged and swallowed so a flaky network never blocks
  // app launch or the agent's existing read path.
  void syncCommunityLore();
});

// Bound at ~4s: covers a normal flush, short of "did the app freeze?".
const SHUTDOWN_TIMEOUT_MS = 4000;

async function gracefulShutdown(): Promise<void> {
  stopAllWatches();
  monitor.stop();
  confirmGate.cancelAll();
  cancelActiveRebuild();
  closeIndexDb();
  await host.shutdown();
  await shutdownTelemetry();
}

app.on('window-all-closed', async () => {
  // Race teardown against a watchdog. PostHog's network flush and
  // session.abort() (model HTTP calls that don't honour AbortSignal) can
  // hang indefinitely; without this the main process lingers, holds the
  // single-instance lock, and blocks future launches.
  await Promise.race([
    gracefulShutdown().catch((err) => {
      console.error('Shutdown error:', err);
    }),
    new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]);
  if (process.platform !== 'darwin') {
    // app.exit() bypasses Electron's own quit sequence, so we go down even
    // if a wedged renderer or utility process would have kept app.quit()
    // pending.
    app.exit(0);
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Cmd-Q on macOS bypasses window-all-closed. Flush telemetry here so events
// from the last session aren't lost.
app.on('before-quit', () => {
  void shutdownTelemetry();
});
