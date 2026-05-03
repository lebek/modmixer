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
  CURRENT_ONBOARDING_VERSION,
  hasCompletedOnboarding,
  hasCurrentConsent,
  loadSettings,
  recordConsent,
  recordOnboardingComplete,
  resetOnboarding,
  saveSettings,
  type ModelSelection,
  type ThemePreference,
} from './agent/settings.js';
import { setRimWorldInstallOverride } from './agent/paths.js';
import { invalidatePathPolicyRoots } from './agent/security/policy-roots.js';
import { detectEnv } from './agent/env-detect.js';
import {
  initTelemetry,
  setAnalyticsOptIn,
  shutdownTelemetry,
  track,
} from './agent/telemetry.js';
import {
  listConversations,
  listConversationsForMod,
  getActiveForMod,
  setActiveForMod,
  clearActiveForMod,
  type ConversationScope,
} from './agent/conversations.js';
import {
  deleteWorkspaceMod,
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
import {
  getRegistry,
  analyzeSnapshot,
  autosort,
  getCommunityRules,
  refreshCommunityRules,
  getSessionManager,
  computeTestSet,
  diffActiveLists,
  type AnalysisResult,
  type RegistryMod,
  type RegistrySnapshot,
} from './agent/registry/index.js';
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
  stopWatching,
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
// log watcher, …). main.ts updates this again when the user picks a folder.
setRimWorldInstallOverride(loadSettings().rimworldInstallOverride);

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

interface RegistryEnvelope {
  snapshot: RegistrySnapshot;
  analysis: AnalysisResult;
}

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

// Onboarding — gates the main UI on first launch.
ipcMain.handle('modmixer:onboarding:get-status', () => ({
  required: CURRENT_ONBOARDING_VERSION,
  completed: loadSettings().onboarding,
  /** True when the renderer should show the onboarding flow on this launch. */
  shouldShow: !hasCompletedOnboarding(),
}));

ipcMain.handle('modmixer:onboarding:complete', () => {
  return recordOnboardingComplete(CURRENT_ONBOARDING_VERSION);
});

ipcMain.handle('modmixer:onboarding:reset', () => {
  return resetOnboarding();
});

ipcMain.handle('modmixer:env:detect', () => detectEnv());

ipcMain.handle('modmixer:env:browse-rimworld-install', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Pick your RimWorld install folder',
    message:
      'Choose the folder containing RimWorldWin64_Data, RimWorldMac.app, or RimWorldLinux_Data.',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const chosen = result.filePaths[0];
  // Persist + push the override into the path resolver so a follow-up
  // detectEnv() picks it up immediately.
  saveSettings({ rimworldInstallOverride: chosen });
  setRimWorldInstallOverride(chosen);
  invalidatePathPolicyRoots();
  // Refresh the registry so the env snapshot's mod counts reflect the new
  // install. start() is idempotent.
  await registry.start();
  await registry.refresh();
  return chosen;
});

ipcMain.handle('modmixer:env:clear-rimworld-install-override', async () => {
  saveSettings({ rimworldInstallOverride: null });
  setRimWorldInstallOverride(null);
  invalidatePathPolicyRoots();
  await registry.refresh();
  return null;
});

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

ipcMain.handle('modmixer:mods:delete', async (_evt, folder: string) => {
  // Order matters: read packageId before the folder is gone, then drop it
  // from ModsConfig.xml (best-effort — RimWorld may not be installed yet),
  // then nuke the symlink + folder, then clean up watchers and chats.
  const about = await readModAbout(folder);
  const packageId = about?.packageId?.trim().toLowerCase() ?? '';
  if (packageId) {
    try {
      await registry.start();
      await registry.refresh();
      await registry.removeActiveMod(packageId);
    } catch (err) {
      console.warn('[delete-mod] removeActiveMod failed (continuing):', err);
    }
  }
  stopWatching(folder);
  await deleteWorkspaceMod(folder);
  // Drop any chats scoped to this mod and their session files.
  for (const convo of listConversationsForMod(folder)) {
    try {
      await host.deleteConversation(convo.id);
    } catch (err) {
      console.warn('[delete-mod] deleteConversation failed (continuing):', err);
    }
  }
  emitModChanged(folder);
  await registry.refresh();
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

ipcMain.handle(
  'modmixer:mods:write-deps',
  async (
    _evt,
    folder: string,
    deps: {
      modDependencies: import('./agent/registry/about-xml.js').ModDependency[];
      loadAfter: string[];
      loadBefore: string[];
      incompatibleWith: string[];
    },
  ) => {
    const updated = await writeAbout(folder, {
      modDependencies: deps.modDependencies,
      loadAfter: deps.loadAfter,
      loadBefore: deps.loadBefore,
      incompatibleWith: deps.incompatibleWith,
    });
    emitModChanged(folder);
    await registry.refresh();
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

// Registry: full system mod view (DLCs + local + workshop + workspace).
ipcMain.handle('modmixer:registry:get', async () => {
  await registry.refresh();
  return buildRegistryEnvelope();
});

ipcMain.handle('modmixer:registry:refresh', async () => {
  await registry.refresh();
  return buildRegistryEnvelope();
});

ipcMain.handle(
  'modmixer:registry:set-active',
  async (_evt, packageIds: string[]) => {
    await registry.setActiveMods(packageIds);
    return buildRegistryEnvelope();
  },
);

ipcMain.handle('modmixer:registry:autosort', async () => {
  const snapshot = registry.getSnapshot();
  const rules = await getCommunityRules();
  const result = autosort({
    activeOrder: snapshot.activeOrder,
    snapshot,
    rules: rules.byPackageId,
  });
  return result;
});

ipcMain.handle('modmixer:registry:apply-autosort', async () => {
  const snapshot = registry.getSnapshot();
  const rules = await getCommunityRules();
  const result = autosort({
    activeOrder: snapshot.activeOrder,
    snapshot,
    rules: rules.byPackageId,
  });
  await registry.setActiveMods(result.order);
  return { envelope: buildRegistryEnvelope(), conflicts: result.conflicts };
});

// Add a mod to <activeMods> together with its installed transitive deps,
// then autosort. Mirrors what `ship_and_launch` does so the UI's "enable"
// and "+deps" actions can't drift from the agent's flow. Returns the new
// envelope plus a summary of what changed for banner display.
ipcMain.handle(
  'modmixer:registry:enable-with-deps',
  async (_evt, packageId: string) => {
    const target = packageId.toLowerCase();
    await registry.refresh();
    const snapshot = registry.getSnapshot();
    const before = snapshot.activeOrder.slice();
    const beforeSet = new Set(before);

    const installedByPid = new Map<string, RegistryMod>();
    for (const m of snapshot.mods) {
      if (m.about.packageIdLc) installedByPid.set(m.about.packageIdLc, m);
    }

    const closure = new Set<string>();
    const missingDeps = new Set<string>();
    const queue: string[] = [target];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const pid = queue.shift()!;
      if (visited.has(pid)) continue;
      visited.add(pid);
      const m = installedByPid.get(pid);
      if (!m) continue;
      for (const dep of m.about.modDependencies) {
        const depPid = dep.packageIdLc;
        if (!depPid) continue;
        if (installedByPid.has(depPid)) {
          closure.add(depPid);
          queue.push(depPid);
        } else {
          missingDeps.add(dep.displayName || depPid);
        }
      }
    }

    const desired = before.slice();
    const added: string[] = [];
    const alreadyActive = beforeSet.has(target);
    if (!alreadyActive && installedByPid.has(target)) {
      desired.push(target);
      added.push(target);
    }
    for (const dep of closure) {
      if (!beforeSet.has(dep)) {
        desired.push(dep);
        added.push(dep);
      }
    }

    const rules = await getCommunityRules();
    const sorted = autosort({
      activeOrder: desired,
      snapshot,
      rules: rules.byPackageId,
    });

    const changed =
      sorted.order.length !== before.length ||
      sorted.order.some((p, i) => p !== before[i]);
    if (changed) {
      await registry.setActiveMods(sorted.order);
    }

    return {
      envelope: buildRegistryEnvelope(),
      added,
      missing: Array.from(missingDeps),
      alreadyActive,
      conflicts: sorted.conflicts,
    };
  },
);

ipcMain.handle('modmixer:registry:community-rules', async () => {
  const snap = await getCommunityRules();
  // Maps don't always cross IPC happily depending on Electron settings —
  // serialize to a plain object for the renderer.
  const rules: Record<string, unknown> = {};
  for (const [k, v] of snap.byPackageId) rules[k] = v;
  return {
    fetchedAt: snap.fetchedAt,
    source: snap.source,
    count: snap.byPackageId.size,
    rules,
  };
});

ipcMain.handle('modmixer:registry:refresh-community-rules', async () => {
  const snap = await refreshCommunityRules();
  return {
    fetchedAt: snap.fetchedAt,
    source: snap.source,
    count: snap.byPackageId.size,
  };
});

// Sessions: snapshot-restore primitive used by Test Mode and Fix Mode.
ipcMain.handle('modmixer:session:get-active', () => sessions.getActive());

ipcMain.handle(
  'modmixer:session:start-test',
  async (_evt, args: { folder: string; packageId: string }) => {
    const snapshot = registry.getSnapshot();
    const rules = (await getCommunityRules()).byPackageId;
    const testSet = computeTestSet({
      snapshot,
      targetPackageId: args.packageId.toLowerCase(),
      rules,
    });
    const session = await sessions.startTestSession({
      folder: args.folder,
      packageId: args.packageId.toLowerCase(),
      reducedActive: testSet.reducedActive,
    });
    return { session, testSet, envelope: buildRegistryEnvelope() };
  },
);

ipcMain.handle('modmixer:session:start-fix', async () => {
  const snapshot = registry.getSnapshot();
  const session = await sessions.startFixSession(snapshot.activeOrder);
  return { session, envelope: buildRegistryEnvelope() };
});

ipcMain.handle('modmixer:session:apply', async () => {
  await sessions.apply();
  return { envelope: buildRegistryEnvelope() };
});

ipcMain.handle('modmixer:session:revert', async () => {
  await sessions.revert();
  await registry.refresh();
  return { envelope: buildRegistryEnvelope() };
});

ipcMain.handle('modmixer:session:diff', () => {
  const session = sessions.getActive();
  if (!session) return null;
  const initial = session.initialActive ?? [];
  const current = registry.getSnapshot().activeOrder;
  return diffActiveLists(initial, current);
});

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
