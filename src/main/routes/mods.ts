import { dialog } from 'electron';
import {
  createUntitledMod,
  deleteWorkspaceMod,
  getWorkspacePaths,
  importModFromFolder,
  listWorkspaceMods,
  readModAbout,
  syncModToGame,
  unsyncModFromGame,
  writeAbout,
  type AboutMetadata,
  type ImportModResult,
  type WorkspaceMod,
} from '../../agent/workspace.js';
import { readSchematic } from '../../agent/schematic.js';
import { scanDefs } from '../../agent/defs-scan.js';
import { buildDefGraph } from '../../agent/def-graph.js';
import { emitModChanged } from '../../agent/mod-events.js';
import {
  disableModInGame,
  enableModInGame,
  isRimWorldRunning,
  launchRimWorld,
  quitRimWorld,
} from '../../agent/game.js';
import { stopWatching } from '../../agent/assets/watcher.js';
import {
  getRegistry,
  type ModDependency,
} from '../../agent/registry/index.js';
import { listConversationsForMod } from '../../agent/conversations.js';
import { deleteAllSaves } from '../../agent/snapshots.js';
import type { RouteContext } from './context.js';

/**
 * Workspace mod CRUD + reads (About, schematic, defs, def graph) +
 * RimWorld launch/quit/run-state. They all share the workspace dir state
 * machine, so they live together.
 */
export function registerModRoutes(ctx: RouteContext): void {
  const { ipc, host, getWindow, requireConsent } = ctx;
  const registry = getRegistry();

  ipc.handle('modmixer:mods:list-workspace', () => listWorkspaceMods());

  ipc.handle('modmixer:mods:sync-to-game', async (_evt, folder: string) => {
    await syncModToGame(folder);
    return await listWorkspaceMods();
  });

  ipc.handle('modmixer:mods:unsync-from-game', async (_evt, folder: string) => {
    await unsyncModFromGame(folder);
    return await listWorkspaceMods();
  });

  ipc.handle('modmixer:mods:delete', async (_evt, folder: string) => {
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
    // The mod's save history goes with it — saves are useless without the
    // mod folder to restore into.
    try {
      await deleteAllSaves(folder);
    } catch (err) {
      console.warn('[delete-mod] deleteAllSaves failed (continuing):', err);
    }
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

  ipc.handle('modmixer:workspace:paths', () => getWorkspacePaths());

  ipc.handle('modmixer:mods:create-untitled', async (): Promise<{
    folder: string;
    mods: WorkspaceMod[];
  }> => {
    requireConsent();
    const { folder } = await createUntitledMod();
    emitModChanged(folder);
    await registry.refresh();
    return { folder, mods: await listWorkspaceMods() };
  });

  ipc.handle('modmixer:mods:import-from-folder', async (): Promise<{
    result: ImportModResult;
    mods: WorkspaceMod[];
  } | null> => {
    const win = getWindow();
    if (!win) return null;
    const dialogResult = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Pick a mod folder to import',
      message:
        'Choose a RimWorld mod folder to copy into the Modmixer workspace.',
    });
    if (dialogResult.canceled || dialogResult.filePaths.length === 0) return null;
    const result = await importModFromFolder(dialogResult.filePaths[0]);
    emitModChanged(result.folder);
    await registry.refresh();
    return { result, mods: await listWorkspaceMods() };
  });

  ipc.handle('modmixer:mods:read-about', (_evt, folder: string) =>
    readModAbout(folder),
  );

  ipc.handle('modmixer:mods:read-schematic', (_evt, folder: string) =>
    readSchematic(folder),
  );

  ipc.handle('modmixer:mods:scan-defs', (_evt, folder: string) =>
    scanDefs(folder),
  );

  ipc.handle('modmixer:mods:def-graph', async (_evt, folder: string) => {
    const defs = await scanDefs(folder);
    return buildDefGraph(defs);
  });

  ipc.handle(
    'modmixer:mods:write-about',
    async (_evt, folder: string, patch: Partial<AboutMetadata>) => {
      const updated = await writeAbout(folder, patch);
      emitModChanged(folder);
      return updated;
    },
  );

  ipc.handle(
    'modmixer:mods:write-deps',
    async (
      _evt,
      folder: string,
      deps: {
        modDependencies: ModDependency[];
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

  ipc.handle('modmixer:mods:enable-in-game', (_evt, folder: string) =>
    enableModInGame(folder),
  );

  ipc.handle('modmixer:mods:disable-in-game', (_evt, folder: string) =>
    disableModInGame(folder),
  );

  ipc.handle('modmixer:game:launch', () => launchRimWorld());
  ipc.handle('modmixer:game:is-running', () => isRimWorldRunning());
  ipc.handle('modmixer:game:quit', () => quitRimWorld());
}
