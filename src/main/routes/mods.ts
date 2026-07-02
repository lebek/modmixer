import path from 'node:path';
import { dialog } from 'electron';
import {
  createUntitledMod,
  deleteWorkspaceMod,
  getWorkspaceMod,
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
import { getAdapter } from '../../agent/adapters/index.js';
import { readModPrefs } from '../../agent/mod-prefs.js';
import { readSchematic } from '../../agent/schematic.js';
import { scanDefs } from '../../agent/defs-scan.js';
import { emitModChanged } from '../../agent/mod-events.js';
import {
  disableModInGame,
  enableModInGame,
  isRimWorldRunning,
  launchRimWorld,
  quitRimWorld,
} from '../../agent/rimworld/game.js';
import { stopWatching } from '../../agent/assets/watcher.js';
import {
  getRegistry,
  type ModDependency,
} from '../../agent/registry/index.js';
import { listConversationsForMod } from '../../agent/conversations.js';
import { deleteAllSaves } from '../../agent/snapshots.js';
import { loadSettings } from '../../agent/settings.js';
import { getGame, resolveGameId } from '../../agent/games/registry.js';
import type { GameId } from '../../agent/games/types.js';
import type { RouteContext } from './context.js';

/**
 * Workspace mod CRUD + reads (About, schematic, defs) + RimWorld
 * launch/quit/run-state. They all share the workspace dir state machine,
 * so they live together.
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

  ipc.handle('modmixer:mods:create-untitled', async (
    _evt,
    game?: GameId,
  ): Promise<{
    folder: string;
    mods: WorkspaceMod[];
  }> => {
    requireConsent();
    // Caller may pick the game (library dropdown); otherwise default to the
    // user's active game. resolveGameId coerces anything unknown to rimworld.
    const targetGame = game ? resolveGameId(game) : loadSettings().selectedGameId;
    const { folder } = await createUntitledMod(targetGame);
    emitModChanged(folder);
    await registry.refresh();
    return { folder, mods: await listWorkspaceMods() };
  });

  ipc.handle('modmixer:mods:import-from-folder', async (): Promise<{
    result: ImportModResult;
    mods: WorkspaceMod[];
  } | null> => {
    // Folder import synthesizes a RimWorld About.xml, so it's gated on the
    // folderImport capability. The UI hides the button for games without it
    // (mods-view's canImport); this is the matching server-side backstop so the
    // channel can't quietly produce a RimWorld mod while the user is on, say,
    // the Minecraft tab.
    if (!getGame(resolveGameId(loadSettings().selectedGameId)).capabilities.folderImport) {
      throw new Error(
        'Importing an existing mod folder is only supported for RimWorld right now.',
      );
    }
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

  // Identity reads/writes dispatch through the game adapter: RimWorld uses
  // About.xml, Minecraft gradle.properties (where renaming the id rebrands the
  // whole project — @Mod id, Java packages, resource namespaces). write-deps
  // below stays a direct About.xml patch; it's RimWorld-only.
  ipc.handle('modmixer:mods:read-about', async (_evt, folder: string) => {
    const prefs = await readModPrefs(folder);
    const { workspaceDir } = getWorkspacePaths();
    return getAdapter(prefs.game).readModMetadata(
      path.join(workspaceDir, folder),
      folder,
    );
  });

  ipc.handle('modmixer:mods:read-schematic', (_evt, folder: string) =>
    readSchematic(folder),
  );

  ipc.handle('modmixer:mods:scan-defs', (_evt, folder: string) =>
    scanDefs(folder),
  );

  ipc.handle(
    'modmixer:mods:write-about',
    async (_evt, folder: string, patch: Partial<AboutMetadata>) => {
      const prefs = await readModPrefs(folder);
      const { workspaceDir } = getWorkspacePaths();
      await getAdapter(prefs.game).writeModMetadata(
        path.join(workspaceDir, folder),
        folder,
        patch,
      );
      emitModChanged(folder);
      return getWorkspaceMod(folder);
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

  ipc.handle('modmixer:rimworld:enable-mod', (_evt, folder: string) =>
    enableModInGame(folder),
  );

  ipc.handle('modmixer:rimworld:disable-mod', (_evt, folder: string) =>
    disableModInGame(folder),
  );

  ipc.handle('modmixer:rimworld:launch', () => launchRimWorld());
  ipc.handle('modmixer:rimworld:is-running', () => isRimWorldRunning());
  ipc.handle('modmixer:rimworld:quit', () => quitRimWorld());
}
