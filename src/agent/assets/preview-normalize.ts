import { nativeImage } from 'electron';
import path from 'node:path';
import fsp from 'node:fs/promises';

// Steam Workshop's preview-image cap is exactly 1 MiB; uploads above that
// fail with k_EResultLimitExceeded ("limit exceeded" / GenericFailure).
// Leave a small margin so we don't ship right at the edge.
const STEAM_PREVIEW_LIMIT_BYTES = 1024 * 1024;
const SAFETY_MARGIN_BYTES = 50 * 1024;
const TARGET_BYTES = STEAM_PREVIEW_LIMIT_BYTES - SAFETY_MARGIN_BYTES;

// Long-edge ladder. The renderer emits 1280×720; user uploads can be anything.
// We step the long edge down until the encoded PNG fits under TARGET_BYTES.
const LONG_EDGE_LADDER = [1280, 1024, 854, 640, 512] as const;

export interface NormalizeResult {
  buffer: Buffer;
  width: number;
  height: number;
}

/**
 * Encode an image as a PNG that fits Steam Workshop's preview-image cap.
 * Accepts any format Electron's nativeImage can decode (PNG, JPEG). Steps the
 * long edge down progressively; never upscales. The smallest rung is returned
 * as a best effort if even 512px doesn't fit (extremely unlikely for screen
 * imagery; would only happen with hostile inputs).
 */
export async function normalizePreviewBuffer(
  input: Buffer,
): Promise<NormalizeResult> {
  const src = nativeImage.createFromBuffer(input);
  if (src.isEmpty()) {
    throw new Error('Could not decode image. Use a PNG or JPEG file.');
  }

  const { width: srcW, height: srcH } = src.getSize();
  const isWide = srcW >= srcH;
  const srcLong = isWide ? srcW : srcH;

  let last: NormalizeResult | undefined;
  let prevTargetLong = Number.POSITIVE_INFINITY;
  for (const dim of LONG_EDGE_LADDER) {
    const targetLong = Math.min(dim, srcLong);
    // Skip ladder rungs that don't actually shrink the image.
    if (targetLong >= prevTargetLong) continue;
    prevTargetLong = targetLong;

    const resized =
      targetLong === srcLong
        ? src
        : src.resize(
            isWide
              ? { width: targetLong, quality: 'best' }
              : { height: targetLong, quality: 'best' },
          );
    const png = resized.toPNG();
    const { width, height } = resized.getSize();
    last = { buffer: png, width, height };
    if (png.length <= TARGET_BYTES) return last;
  }
  // Should be unreachable for normal inputs; ladder bottoms out well under cap.
  return last!;
}

export async function normalizePreviewToFile(
  srcPath: string,
  destPath: string,
): Promise<NormalizeResult> {
  const buf = await fsp.readFile(srcPath);
  const result = await normalizePreviewBuffer(buf);
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.writeFile(destPath, result.buffer);
  return result;
}
