import type { BrowserWindow } from 'electron';
import {
  cleanupModHistory,
  deleteAllSaves,
  deleteSave,
  KEEP_AUTOSAVES,
  listSaves,
  onSnapshotsChanged,
  renameSave,
  snapshotUsage,
  type SnapshotCleanupProgressEvent,
  type SnapshotCleanupSummary,
  type SnapshotUsageModRow,
  type SnapshotUsageReport,
} from '../../agent/snapshots.js';
import { getWorkspacePaths, listWorkspaceMods } from '../../agent/workspace.js';
import type { RouteContext } from './context.js';
import path from 'node:path';
import fs from 'node:fs';

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

  // Storage panel: per-mod snapshot disk usage, joined with workspace
  // identity so the renderer can show display names and flag orphans.
  ipc.handle(
    'modmixer:snapshots:usage',
    async (): Promise<SnapshotUsageReport> => {
      const [usage, mods] = await Promise.all([
        snapshotUsage(),
        listWorkspaceMods(),
      ]);
      const names = new Map(mods.map((m) => [m.folder, m.about.name]));
      const rows: SnapshotUsageModRow[] = usage.rows.map((row) => ({
        ...row,
        name: names.get(row.folder) ?? row.folder,
        orphaned: !names.has(row.folder),
      }));
      return {
        rows,
        totalBytes: usage.totalBytes,
        keepAutosaves: KEEP_AUTOSAVES,
      };
    },
  );

  // Storage cleanup: sequential per-mod queue with progress pushes. Each
  // mod is compacted atomically (crash-safe swap in snapshot-compact.ts),
  // so re-running after an interruption is always safe. Orphaned snapshot
  // dirs — no matching workspace mod anymore — are removed wholesale.
  ipc.handle(
    'modmixer:snapshots:cleanup',
    async (_evt, folders: string[]): Promise<SnapshotCleanupSummary> => {
      const { workspaceDir } = getWorkspacePaths();
      let freedBytes = 0;
      let failures = 0;
      for (const folder of folders) {
        sendCleanupProgress(getWindow(), {
          folder,
          status: 'working',
        });
        try {
          const orphaned = !fs.existsSync(path.join(workspaceDir, folder));
          const freed = orphaned
            ? await deleteAllSaves(folder)
            : (await cleanupModHistory(folder)).freedBytes;
          freedBytes += freed;
          sendCleanupProgress(getWindow(), {
            folder,
            status: 'done',
            freedBytes: freed,
          });
        } catch (err) {
          failures++;
          sendCleanupProgress(getWindow(), {
            folder,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { freedBytes, failures };
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

function sendCleanupProgress(
  win: BrowserWindow | null,
  event: SnapshotCleanupProgressEvent,
): void {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (wc.isDestroyed() || wc.isCrashed()) return;
  try {
    wc.send('modmixer:snapshots:cleanup-progress', event);
  } catch {
    // Render frame disposed mid-send; nothing actionable.
  }
}
