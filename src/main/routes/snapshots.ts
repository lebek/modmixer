import {
  deleteSave,
  listSaves,
  onSnapshotsChanged,
  renameSave,
} from '../../agent/snapshots.js';
import { listWorkspaceMods } from '../../agent/workspace.js';
import type { RouteContext } from './context.js';

/**
 * Saves (snapshots) — the gamer-facing rollback feature.
 *
 * "Save" is folder-scoped: the renderer passes the focused mod's folder and
 * a label, and the host snapshots that folder plus its chat slice.
 * List/rename/delete are folder-scoped too, so the saves sidebar can render
 * even when the conversation has been deleted. Restore always goes through
 * the host so chat-rewind can dispose+reconstruct any sessions scoped to
 * the mod being restored.
 */
export function registerSnapshotsRoutes(ctx: RouteContext): void {
  const { ipc, getWindow, host } = ctx;

  ipc.handle('modmixer:snapshots:list', (_evt, folder: string) =>
    listSaves(folder),
  );

  ipc.handle(
    'modmixer:snapshots:save',
    (_evt, folder: string, label: string | null) =>
      host.commitManualSave(folder, label),
  );

  ipc.handle(
    'modmixer:snapshots:rename',
    (_evt, folder: string, sha: string, label: string | null) =>
      renameSave(folder, sha, label),
  );

  ipc.handle('modmixer:snapshots:delete', (_evt, folder: string, sha: string) =>
    deleteSave(folder, sha),
  );

  ipc.handle(
    'modmixer:snapshots:restore',
    async (_evt, folder: string, sha: string) => {
      const hydrated = await host.restoreSave({ folder, sha });
      // Mod folder contents may have changed entirely (file additions /
      // deletions, About.xml swaps, etc.). Hand back a fresh mods list so
      // the renderer doesn't have to chase a separate refresh.
      const mods = await listWorkspaceMods();
      return { mods, hydrated };
    },
  );

  // Push save-list updates to the renderer. The same race-tolerant send
  // pattern AgentHost uses applies here — the renderer can be mid-reload.
  onSnapshotsChanged((event) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    if (wc.isDestroyed() || wc.isCrashed()) return;
    try {
      wc.send('modmixer:snapshots:changed', event);
    } catch {
      // Render frame disposed mid-send; nothing actionable.
    }
  });
}
