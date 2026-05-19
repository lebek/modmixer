import { dialog } from 'electron';
import { prepareAttachments } from '../../agent/attachments/prepare.js';
import type { AttachmentInput } from '../../agent/attachments/types.js';
import type { RouteContext } from './context.js';

/**
 * Chat file attachments: resolve renderer inputs (paths or pasted bytes) into
 * `PreparedAttachment`s, and a native file picker for the browse button.
 * Directories come in via drag-drop; the picker is files-only because
 * Windows' open dialog can't offer files and folders in one pass.
 */
export function registerAttachmentRoutes(ctx: RouteContext): void {
  const { ipc, getWindow } = ctx;

  ipc.handle(
    'modmixer:attachments:prepare',
    (_evt, inputs: AttachmentInput[]) => prepareAttachments(inputs),
  );

  ipc.handle('modmixer:attachments:pick', async () => {
    const win = getWindow();
    if (!win) return [];
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    return prepareAttachments(
      result.filePaths.map((p) => ({ kind: 'path', path: p })),
    );
  });
}
