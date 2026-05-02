// MUST be the first import: installs uncaughtException/unhandledRejection
// handlers before any other module body runs. Catches startup crashes that
// happen during bundled require() — too early for initSentry() to help.
import { SMOKE_TEST } from './agent/early-error.js';
import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, shell } from 'electron';
import path from 'node:path';
import fsp from 'node:fs/promises';
import started from 'electron-squirrel-startup';
import { updateElectronApp } from 'update-electron-app';
import { initSentry } from './agent/sentry.js';

// Initialize Sentry as early as possible so any failure during app
// construction is reported. Must run before AgentHost imports do anything
// non-trivial (pi-mono touches the network).
initSentry();

import { AgentHost } from './agent/agent-host.js';
import {
  CURRENT_CONSENT_VERSION,
  hasCurrentConsent,
  loadSettings,
  recordConsent,
  saveSettings,
  type ModelSelection,
  type ThemePreference,
} from './agent/settings.js';
import {
  initTelemetry,
  setAnalyticsOptIn,
  shutdownTelemetry,
  track,
} from './agent/telemetry.js';
import {
  listConversations,
  getActiveForMod,
  setActiveForMod,
  clearActiveForMod,
  type ConversationScope,
} from './agent/conversations.js';
import {
  listWorkspaceMods,
  syncModToGame,
  unsyncModFromGame,
  getWorkspacePaths,
  readModAbout,
  writeAbout,
  type AboutMetadata,
} from './agent/workspace.js';
import { readSchematic } from './agent/schematic.js';
import { userLoreDir, modLoreDir } from './agent/lore.js';
import { scanDefs } from './agent/defs-scan.js';
import { buildDefGraph } from './agent/def-graph.js';
import { onModChanged, emitModChanged } from './agent/mod-events.js';
import {
  enableModInGame,
  disableModInGame,
  launchRimWorldViaSteam,
  isRimWorldRunning,
  quitRimWorld,
} from './agent/game.js';
import { getLogWatcher } from './agent/log-watcher.js';
import { getMonitorServer } from './agent/monitor/server.js';
import type { BridgeMessage, MonitorConnectionState } from './agent/monitor/protocol.js';
import { scanAssets } from './agent/assets/scanner.js';
import {
  addAssetFile,
  removeAssetFile,
  readAssetDataUrl,
} from './agent/assets/store.js';
import {
  ensureWatching,
  onAssetsChanged,
  stopAllWatches,
} from './agent/assets/watcher.js';
import type { AssetKind } from './agent/assets/types.js';
import {
  publishToWorkshop,
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
  getIndexSnapshot,
  pipeProgressToWindow,
  startRebuild,
} from './agent/index/main-bridge.js';
import { closeIndexDb } from './agent/index/db.js';

if (started) {
  app.quit();
}

// In dev the app name comes from Electron's defaults (which says "Electron")
// rather than package.json's productName. Force it so the dock tooltip,
// About menu, and userData paths match the packaged app.
app.setName('Modmixer');

// Auto-update from GitHub releases. No-ops in dev and on unsigned mac
// builds; logs but won't throw if the feed is unreachable.
updateElectronApp({
  repo: 'lebek/modmixer',
  updateInterval: '1 hour',
});

let mainWindow: BrowserWindow | null = null;
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
const host = new AgentHost(() => mainWindow);
// Eagerly initialize the log watcher so the agent finds an active instance
// the first time it monitors Player.log.
getLogWatcher();

function requireConsent(): void {
  if (!hasCurrentConsent()) {
    throw new Error(
      'Consent not accepted. The agent is disabled until the user accepts the consent screen.',
    );
  }
}

ipcMain.handle('modmixer:agent:send', async (_evt, text: string) => {
  requireConsent();
  await host.send(text);
});

ipcMain.handle('modmixer:agent:interrupt', async () => {
  await host.interrupt();
});

ipcMain.handle('modmixer:consent:get', () => ({
  required: CURRENT_CONSENT_VERSION,
  accepted: loadSettings().consent,
}));

ipcMain.handle(
  'modmixer:consent:accept',
  async (_evt, options?: { analyticsOptIn?: boolean }) => {
    const next = recordConsent(CURRENT_CONSENT_VERSION);
    await setAnalyticsOptIn(options?.analyticsOptIn !== false);
    return next;
  },
);

ipcMain.handle('modmixer:app:version', () => app.getVersion());

ipcMain.handle('modmixer:settings:get', () => loadSettings());

ipcMain.handle(
  'modmixer:settings:set-model',
  async (_evt, selection: ModelSelection) => {
    const next = saveSettings({ model: selection });
    await host.setModel(selection);
    return next;
  },
);

ipcMain.handle(
  'modmixer:settings:set-default-author',
  (_evt, defaultAuthor: string) => saveSettings({ defaultAuthor }),
);

ipcMain.handle(
  'modmixer:settings:set-analytics-opt-in',
  async (_evt, optIn: boolean) => {
    await setAnalyticsOptIn(optIn);
    return loadSettings();
  },
);

ipcMain.handle(
  'modmixer:settings:set-theme',
  (_evt, theme: ThemePreference) => saveSettings({ theme }),
);

ipcMain.handle('modmixer:models:list', () => host.listAvailableModels());

// RimWorld source/def index. The renderer pulls a snapshot on demand and
// listens for progress events; the main process kicks off the build at
// startup and on user request from Settings.
ipcMain.handle('modmixer:index:get-snapshot', () => getIndexSnapshot());

ipcMain.handle('modmixer:index:rebuild', async (_evt, options: { force?: boolean } = {}) => {
  return startRebuild(options);
});

ipcMain.handle('modmixer:index:cancel', () => {
  cancelActiveRebuild();
  return getIndexSnapshot();
});

ipcMain.handle('modmixer:oauth:list', () => host.listOAuthLinks());

ipcMain.handle('modmixer:oauth:login', async (_evt, providerId: string) => {
  // Fire-and-forget: the long-running login emits its own state events. We
  // resolve the IPC immediately so the renderer never blocks on it.
  void host.loginOAuth(providerId);
});

ipcMain.handle('modmixer:oauth:cancel-login', () => {
  host.cancelOAuthLogin();
});

ipcMain.handle(
  'modmixer:oauth:provide-code',
  (_evt, providerId: string, value: string) => {
    host.provideOAuthCode(providerId, value);
  },
);

ipcMain.handle('modmixer:oauth:logout', async (_evt, providerId: string) => {
  await host.logoutOAuth(providerId);
});

ipcMain.handle('modmixer:conversations:list', () => listConversations());

ipcMain.handle(
  'modmixer:conversations:create',
  (_evt, scope: ConversationScope, title?: string) => {
    requireConsent();
    return host.createConversation(scope, title);
  },
);

ipcMain.handle('modmixer:conversations:switch', async (_evt, id: string) => {
  requireConsent();
  const convo = await host.switchTo(id);
  // If this conversation is mod-scoped, mark it active for that mod so the
  // sidebar can recover the right chat on app restart.
  if (convo.scope.type === 'mod') {
    setActiveForMod(convo.scope.modFolder, convo.id);
  }
  return {
    conversation: convo,
    messages: host.getActiveMessages(),
  };
});

ipcMain.handle('modmixer:conversations:delete', async (_evt, id: string) => {
  await host.deleteConversation(id);
});

ipcMain.handle('modmixer:conversations:get-active', () => host.getCurrentId());

ipcMain.handle('modmixer:conversations:get-active-messages', () =>
  host.getActiveMessages(),
);

/**
 * Get-or-create the "active chat" for a mod. If one exists in the index,
 * switch to it; otherwise create a fresh mod-scoped conversation, mark it
 * active, and return its first hydrated state.
 */
ipcMain.handle(
  'modmixer:conversations:open-for-mod',
  async (_evt, folder: string) => {
    requireConsent();
    const existing = getActiveForMod(folder);
    const convo = existing
      ? await host.switchTo(existing.id)
      : await (async () => {
          const created = await host.createConversation({
            type: 'mod',
            modFolder: folder,
          });
          await host.switchTo(created.id);
          setActiveForMod(folder, created.id);
          return created;
        })();
    return {
      conversation: convo,
      messages: host.getActiveMessages(),
    };
  },
);

/**
 * Replace the current chat for a mod with a fresh one. The previous chat
 * stays on disk in the session log, just no longer surfaced as the active
 * chat for this mod.
 */
ipcMain.handle(
  'modmixer:conversations:start-fresh-for-mod',
  async (_evt, folder: string) => {
    requireConsent();
    clearActiveForMod(folder);
    const created = await host.createConversation({
      type: 'mod',
      modFolder: folder,
    });
    await host.switchTo(created.id);
    setActiveForMod(folder, created.id);
    return {
      conversation: created,
      messages: host.getActiveMessages(),
    };
  },
);

ipcMain.handle('modmixer:mods:list-workspace', () => listWorkspaceMods());

ipcMain.handle('modmixer:mods:sync-to-game', async (_evt, folder: string) => {
  await syncModToGame(folder);
  return await listWorkspaceMods();
});

ipcMain.handle('modmixer:mods:unsync-from-game', async (_evt, folder: string) => {
  await unsyncModFromGame(folder);
  return await listWorkspaceMods();
});

ipcMain.handle('modmixer:workspace:paths', () => getWorkspacePaths());

ipcMain.handle('modmixer:mods:read-about', (_evt, folder: string) =>
  readModAbout(folder),
);

ipcMain.handle('modmixer:mods:read-schematic', (_evt, folder: string) =>
  readSchematic(folder),
);

ipcMain.handle('modmixer:mods:scan-defs', (_evt, folder: string) =>
  scanDefs(folder),
);

ipcMain.handle('modmixer:mods:def-graph', async (_evt, folder: string) => {
  const defs = await scanDefs(folder);
  return buildDefGraph(defs);
});

ipcMain.handle(
  'modmixer:mods:write-about',
  async (_evt, folder: string, patch: Partial<AboutMetadata>) => {
    const updated = await writeAbout(folder, patch);
    emitModChanged(folder);
    return updated;
  },
);

ipcMain.handle('modmixer:mods:enable-in-game', (_evt, folder: string) =>
  enableModInGame(folder),
);

ipcMain.handle('modmixer:mods:disable-in-game', (_evt, folder: string) =>
  disableModInGame(folder),
);

ipcMain.handle('modmixer:game:launch', () => launchRimWorldViaSteam());

ipcMain.handle('modmixer:game:is-running', () => isRimWorldRunning());

ipcMain.handle('modmixer:game:quit', () => quitRimWorld());

ipcMain.handle('modmixer:assets:scan', async (_evt, folder: string) => {
  const { workspaceDir } = getWorkspacePaths();
  ensureWatching(folder);
  return scanAssets(path.join(workspaceDir, folder));
});

ipcMain.handle(
  'modmixer:assets:add',
  async (
    _evt,
    folder: string,
    destRelPath: string,
    sourceAbsPath: string,
  ) => {
    await addAssetFile(folder, destRelPath, sourceAbsPath);
    const { workspaceDir } = getWorkspacePaths();
    return scanAssets(path.join(workspaceDir, folder));
  },
);

ipcMain.handle(
  'modmixer:assets:remove',
  async (_evt, folder: string, relPath: string) => {
    await removeAssetFile(folder, relPath);
    const { workspaceDir } = getWorkspacePaths();
    return scanAssets(path.join(workspaceDir, folder));
  },
);

ipcMain.handle(
  'modmixer:assets:read-data-url',
  (_evt, folder: string, relPath: string) =>
    readAssetDataUrl(folder, relPath),
);

ipcMain.handle(
  'modmixer:assets:pick-file',
  async (_evt, kind: AssetKind) => {
    const filters =
      kind === 'audio'
        ? [{ name: 'Ogg audio', extensions: ['ogg'] }]
        : [{ name: 'PNG image', extensions: ['png'] }];
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  },
);

onAssetsChanged((folder) => {
  mainWindow?.webContents.send('modmixer:assets:changed', { folder });
});

onPublishProgress((event: PublishProgressEvent) => {
  mainWindow?.webContents.send('modmixer:workshop:progress', event);
});

ipcMain.handle('modmixer:workshop:publish', (_evt, folder: string) =>
  publishToWorkshop(folder),
);

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

ipcMain.handle('modmixer:monitor:get-state', () => monitor.getState());
ipcMain.handle('modmixer:monitor:get-snapshot', () => monitor.getLastSnapshot());

ipcMain.handle('modmixer:shell:open-external', async (_evt, url: string) => {
  // Allow http(s) for general links, steam:// for Steam client deep-links
  // (e.g. the Workshop legal-agreement page after createItem).
  if (!/^(https?|steam):\/\//i.test(url)) return;
  await shell.openExternal(url);
});

// Power-user escape hatch from Settings → reveal the user-tier or mod-tier
// lore directory in Finder/Explorer. Returns null on success (matches
// shell.openPath's empty-string convention) or an error string for the
// renderer to surface.
ipcMain.handle(
  'modmixer:lore:reveal',
  async (_evt, args: { tier: 'user' | 'mod'; modFolder?: string }) => {
    let dir: string;
    if (args.tier === 'user') {
      dir = userLoreDir();
    } else {
      if (!args.modFolder) return 'modFolder is required for mod-tier lore';
      dir = modLoreDir(args.modFolder);
    }
    // Materialize the directory on first reveal so the user lands inside
    // it instead of seeing "folder does not exist".
    await fsp.mkdir(dir, { recursive: true });
    const err = await shell.openPath(dir);
    return err === '' ? null : err;
  },
);

const createWindow = () => {
  // In dev, the .icns/.ico baked in by Forge isn't available, so set the
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

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: bg,
    icon: devIconPath ?? undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.webContents.openDevTools();
  }
};

app.on('ready', () => {
  initTelemetry();
  track({ name: 'app_started' });
  // safeStorage is only guaranteed available after `ready` on Linux/Windows.
  // The AgentHost constructor ran earlier with an empty cache; refresh it now
  // so previously-stored OAuth creds become visible to the model picker.
  host.primeAfterReady();
  createWindow();
  // Pipe index progress events to the renderer. Subscribed once for the
  // process lifetime — the listener filters by mainWindow internally.
  pipeProgressToWindow(() => mainWindow);
  if (SMOKE_TEST) {
    // CI smoke test: we got past every import + ready handler + window
    // creation without throwing. Skip the index rebuild (fire-and-forget,
    // would dominate CI time) and exit cleanly.
    // eslint-disable-next-line no-console
    console.log('[smoke-test] startup OK, exiting');
    app.exit(0);
    return;
  }
  // Kick off the index rebuild if the cache is stale/missing. Fire-and-
  // forget — the renderer modal will surface progress as it streams in.
  void ensureIndexAtStartup();
});

app.on('window-all-closed', async () => {
  stopAllWatches();
  monitor.stop();
  confirmGate.cancelAll();
  cancelActiveRebuild();
  closeIndexDb();
  await host.shutdown();
  await shutdownTelemetry();
  if (process.platform !== 'darwin') {
    app.quit();
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
