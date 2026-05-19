import { app, nativeImage } from 'electron';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ImageContent } from '@mariozechner/pi-ai';
import type { AttachmentInput, PreparedAttachment } from './types.js';

/**
 * Image formats shown to the model inline as content blocks. Anything else is
 * a path-only attachment the agent reads on demand.
 *
 * GIF is deliberately excluded: `nativeImage` can't decode it, so it would
 * bypass the downscale step and reach the model as a raw, possibly-animated
 * file — a payload that has derailed models in practice.
 */
const MODEL_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** Long-edge cap for images sent to the model — keeps the request small. */
const MAX_MODEL_IMAGE_EDGE = 1568;
/** Long-edge of the chip thumbnail. */
const PREVIEW_EDGE = 96;

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** Where pasted clipboard bitmaps land — they have no source path of their own. */
function attachmentTempDir(): string {
  return path.join(app.getPath('temp'), 'modmixer-attachments');
}

/** Decode an image buffer, shrinking it so its long edge is at most `edge`. */
function decodeResized(buf: Buffer, edge: number) {
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  if (Math.max(width, height) <= edge) return img;
  return img.resize(
    width >= height
      ? { width: edge, quality: 'good' }
      : { height: edge, quality: 'good' },
  );
}

/** Small base64 PNG thumbnail for an image chip, or null if undecodable. */
async function buildPreview(absPath: string): Promise<string | null> {
  try {
    const img = decodeResized(await fsp.readFile(absPath), PREVIEW_EDGE);
    if (!img) return null;
    return `data:image/png;base64,${img.toPNG().toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * Read an image file as a model content block — re-encoded as a downscaled
 * JPEG so a 4K screenshot doesn't bloat the request. This is only the model's
 * *view*; the original file on disk is untouched, so the agent still copies
 * the full-quality source if it wants the image in the mod.
 */
export async function readImageContentForModel(
  absPath: string,
): Promise<ImageContent | null> {
  try {
    const img = decodeResized(await fsp.readFile(absPath), MAX_MODEL_IMAGE_EDGE);
    if (!img) return null;
    return {
      type: 'image',
      data: img.toJPEG(85).toString('base64'),
      mimeType: 'image/jpeg',
    };
  } catch {
    return null;
  }
}

/** True for a file the active vision models can be shown directly. */
export function isModelImagePath(p: string, isDirectory: boolean): boolean {
  return !isDirectory && MODEL_IMAGE_EXTS.has(path.extname(p).toLowerCase());
}

/**
 * Resolve renderer attachment inputs into `PreparedAttachment`s. Pasted byte
 * payloads are written to a temp file first so every attachment is a real
 * path. Inputs that don't resolve (missing file, unreadable) are dropped.
 */
export async function prepareAttachments(
  inputs: AttachmentInput[],
): Promise<PreparedAttachment[]> {
  const out: PreparedAttachment[] = [];
  for (const input of inputs) {
    let absPath: string;
    let name: string;
    if (input.kind === 'bytes') {
      const dir = attachmentTempDir();
      await fsp.mkdir(dir, { recursive: true });
      const ext =
        path.extname(input.name) || MIME_EXT[input.mimeType] || '.png';
      absPath = path.join(dir, `${randomUUID()}${ext}`);
      await fsp.writeFile(absPath, Buffer.from(input.bytes));
      name = input.name || `pasted${ext}`;
    } else {
      absPath = path.resolve(input.path);
      name = path.basename(absPath);
    }

    let isDirectory = false;
    try {
      isDirectory = (await fsp.stat(absPath)).isDirectory();
    } catch {
      continue; // missing/unreadable — skip silently
    }

    const isImage = isModelImagePath(absPath, isDirectory);
    out.push({
      id: randomUUID(),
      path: absPath,
      name,
      isDirectory,
      isImage,
      previewDataUrl: isImage ? await buildPreview(absPath) : null,
    });
  }
  return out;
}
