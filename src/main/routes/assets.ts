import path from 'node:path';
import { dialog } from 'electron';
import { scanAssets } from '../../agent/assets/scanner.js';
import {
  addAssetFile,
  clearPreviewBgSource,
  getPreviewBgSource,
  readAssetDataUrl,
  readPreviewBgSourceDataUrl,
  readVanillaAssetDataUrl,
  removeAssetFile,
  setPreviewBgSource,
  setPreviewImageFile,
} from '../../agent/assets/store.js';
import { writeSlotFile } from '../../agent/assets/fork.js';
import { ensureWatching } from '../../agent/assets/watcher.js';
import type { AssetKind, AssetSlotRef } from '../../agent/assets/types.js';
import {
  getWorkspaceMod,
  getWorkspacePaths,
  type WorkspaceMod,
} from '../../agent/workspace.js';
import { emitModChanged } from '../../agent/mod-events.js';
import {
  linkWorkshopItem,
  publishToWorkshop,
  unlinkWorkshopItem,
} from '../../agent/workshop.js';
import type { RouteContext } from './context.js';

/** Asset CRUD + Workshop publish/link/unlink. */
export function registerAssetsRoutes(ctx: RouteContext): void {
  const { ipc, getWindow } = ctx;

  ipc.handle('modmixer:assets:scan', async (_evt, folder: string) => {
    const { workspaceDir } = getWorkspacePaths();
    ensureWatching(folder);
    return scanAssets(path.join(workspaceDir, folder));
  });

  ipc.handle(
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

  /**
   * Slot-aware upload. Unlike `assets:add` (which copies into a fixed path —
   * used for preview/about images), this routes through the fork logic: if
   * the target slot's path is shared with other consumers, the slot's source
   * token gets rewritten to a unique stem and the file lands at the new
   * path, leaving siblings untouched.
   */
  ipc.handle(
    'modmixer:assets:add-slot',
    async (
      _evt,
      folder: string,
      slot: AssetSlotRef,
      sourceAbsPath: string,
    ) => {
      const { workspaceDir } = getWorkspacePaths();
      const modDir = path.join(workspaceDir, folder);
      // Scan first so the fork logic can see all current consumers of the path.
      const pre = await scanAssets(modDir);
      await writeSlotFile(modDir, slot, sourceAbsPath, pre.requirements);
      return scanAssets(modDir);
    },
  );

  ipc.handle(
    'modmixer:assets:set-preview-image',
    async (_evt, folder: string, sourceAbsPath: string) => {
      await setPreviewImageFile(folder, sourceAbsPath);
      const { workspaceDir } = getWorkspacePaths();
      return scanAssets(path.join(workspaceDir, folder));
    },
  );

  ipc.handle(
    'modmixer:assets:remove',
    async (_evt, folder: string, relPath: string) => {
      await removeAssetFile(folder, relPath);
      const { workspaceDir } = getWorkspacePaths();
      return scanAssets(path.join(workspaceDir, folder));
    },
  );

  ipc.handle(
    'modmixer:assets:read-data-url',
    (_evt, folder: string, relPath: string) =>
      readAssetDataUrl(folder, relPath),
  );

  ipc.handle(
    'modmixer:assets:read-vanilla-data-url',
    (_evt, absPath: string) => readVanillaAssetDataUrl(absPath),
  );

  ipc.handle(
    'modmixer:assets:set-preview-bg',
    async (_evt, folder: string, sourceAbsPath: string) => {
      return await setPreviewBgSource(folder, sourceAbsPath);
    },
  );

  ipc.handle(
    'modmixer:assets:clear-preview-bg',
    async (_evt, folder: string) => {
      await clearPreviewBgSource(folder);
    },
  );

  ipc.handle(
    'modmixer:assets:get-preview-bg',
    async (_evt, folder: string) => {
      const abs = getPreviewBgSource(folder);
      if (!abs) return null;
      const dataUrl = await readPreviewBgSourceDataUrl(folder);
      if (!dataUrl) return null;
      return { path: abs, dataUrl };
    },
  );

  ipc.handle('modmixer:assets:pick-file', async (_evt, kind: AssetKind) => {
    const filters =
      kind === 'audio'
        ? [{ name: 'Ogg audio', extensions: ['ogg'] }]
        : [{ name: 'PNG image', extensions: ['png'] }];
    const win = getWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipc.handle('modmixer:assets:pick-preview-bg', async () => {
    const win = getWindow();
    if (!win) return null;
    // Steam screenshots land as JPG (F12 capture); allow PNG/WebP too so users
    // can drop in anything they've cropped/edited.
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [
        { name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipc.handle('modmixer:workshop:publish', async (_evt, folder: string) => {
    const result = await publishToWorkshop(folder);
    // First publish wrote About/PublishedFileId.txt — fan out so the panel
    // re-reads `mod.publishedFileId` and shows the freshly-linked Workshop ID.
    emitModChanged(folder);
    return result;
  });

  ipc.handle(
    'modmixer:workshop:unlink',
    async (_evt, folder: string): Promise<WorkspaceMod | null> => {
      await unlinkWorkshopItem(folder);
      emitModChanged(folder);
      return await getWorkspaceMod(folder);
    },
  );

  ipc.handle(
    'modmixer:workshop:link',
    async (
      _evt,
      folder: string,
      workshopId: string,
    ): Promise<WorkspaceMod | null> => {
      await linkWorkshopItem(folder, workshopId);
      emitModChanged(folder);
      return await getWorkspaceMod(folder);
    },
  );
}
