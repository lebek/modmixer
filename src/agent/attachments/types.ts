/**
 * Chat file attachments. A user can attach files by drag-drop, paste
 * (clipboard bitmap or Explorer copy), or the browse button. The renderer
 * can't read disk, so it hands the main process either a path (drag/browse/
 * Explorer copy) or raw bytes (a pasted screenshot, which has no path). Main
 * resolves both into a `PreparedAttachment` the chip row and `send` use.
 */

/** What the renderer collects from a drop/paste/picker and sends to main. */
export type AttachmentInput =
  | { kind: 'path'; path: string }
  | { kind: 'bytes'; name: string; mimeType: string; bytes: Uint8Array };

/** A resolved attachment: always backed by a real file/dir on disk. */
export interface PreparedAttachment {
  id: string;
  /** Absolute path on disk. Pasted bitmaps are written to a temp file. */
  path: string;
  /** Basename, for the chip label. */
  name: string;
  isDirectory: boolean;
  /** A still image the active model could be shown as a content block. */
  isImage: boolean;
  /** Small base64 thumbnail for image chips; null for non-images/dirs. */
  previewDataUrl: string | null;
}
