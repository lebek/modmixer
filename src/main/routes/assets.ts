import path from 'node:path';
import { dialog } from 'electron';
import { scanAssets } from '../../agent/assets/scanner.js';
import {
  addAssetFile,
  readAssetDataUrl,
  removeAssetFile,
  setPreviewImageFile,
} from '../../agent/assets/store.js';
import { ensureWatching } from '../../agent/assets/watcher.js';
import type { AssetKind } from '../../agent/assets/types.js';
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
