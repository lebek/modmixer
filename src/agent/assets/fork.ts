import path from 'node:path';
import fsp from 'node:fs/promises';
import type { AssetRequirement, AssetSlotRef } from './types.js';

/**
 * Match a scan slot against a SlotRef from the renderer. We match on
 * (kind, path, sourceFile, tokenOffset) — together these uniquely identify a
 * ref site even across rescans, since the source file content + token offset
 * are stable until the file is edited.
 */
function matchesSlot(req: AssetRequirement, ref: AssetSlotRef): boolean {
  return (
    req.kind === ref.kind &&
    req.path === ref.path &&
    req.ref.sourceFile === ref.sourceFile &&
    req.ref.tokenOffset === ref.tokenOffset
  );
}

/**
 * Decide whether an upload to `slot` should fork the underlying ref. Returns
 * the new stem to write at, or `null` when no fork is needed (the upload can
 * land at the slot's existing path).
 *
 * Forks when multiple slots share the same on-disk path AND they don't all
 * originate from the same source token (e.g. Graphic_Multi expansions emit
 * 3 slots from one tag — those count as one consumer, not three).
 */
function chooseForkStem(
  slot: AssetRequirement,
  allRequirements: AssetRequirement[],
): string | null {
  const sharingPath = allRequirements.filter((r) => r.path === slot.path);
  // Distinct "consumers" of the path = distinct source tokens. Slots emitted
  // from a single token (Graphic_Multi north/south/east) share tokenOffset +
  // sourceFile, so they collapse to one consumer.
  const consumers = new Set<string>();
  for (const r of sharingPath) {
    consumers.add(`${r.ref.sourceFile}::${r.ref.tokenOffset}`);
  }
  if (consumers.size <= 1) return null;

  // Pick a unique new stem rooted at the original sourceStem + this slot's
  // defName. The defName is usually unique within the mod; if a collision
  // somehow appears (or the agent picked the same defName twice), bump a
  // numeric suffix until no other slot has it.
  const allStems = new Set(allRequirements.map((r) => r.ref.sourceStem));
  const base = `${slot.ref.sourceStem}_${slot.ref.defName}`;
  if (!allStems.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}_${i}`;
    if (!allStems.has(candidate)) return candidate;
  }
  // Fall through — shouldn't happen in practice.
  return `${base}_${Date.now()}`;
}

/**
 * Rewrite the source token at slot.ref.tokenOffset so it points at newStem
 * instead of slot.ref.sourceStem. Works for XML (`<tag>value</tag>`) and C#
 * (`ContentFinder<T>.Get("value")`) — both shapes are simple string swaps
 * within the original token span.
 */
async function rewriteSourceToken(
  modDir: string,
  sourceFile: string,
  tokenOffset: number,
  tokenLength: number,
  oldStem: string,
  newStem: string,
): Promise<void> {
  const abs = path.join(modDir, ...sourceFile.split('/'));
  const text = await fsp.readFile(abs, 'utf8');
  const token = text.slice(tokenOffset, tokenOffset + tokenLength);
  const newToken = token.replace(oldStem, newStem);
  if (newToken === token) {
    throw new Error(
      `fork rewrite failed: stem ${oldStem} not found in source token at ${sourceFile}:${tokenOffset}`,
    );
  }
  const next = text.slice(0, tokenOffset) + newToken + text.slice(tokenOffset + tokenLength);
  await fsp.writeFile(abs, next, 'utf8');
}

/**
 * Compute the absolute on-disk destination for an upload to a slot whose stem
 * has just been rewritten. Mirrors scanner.ts resolveAssetLocation default
 * behaviour: writes go under the same content root the original path used,
 * with the kind-appropriate subRoot + extension.
 */
function destForNewStem(
  modDir: string,
  oldPath: string,
  oldStem: string,
  newStem: string,
): { absPath: string; relPath: string } {
  // oldPath is e.g. "Common/Textures/Things/Item/Sword.png" or
  // "Textures/Things/Item/Sword.png" — replace the trailing `<oldStem>.<ext>`
  // segment with `<newStem>.<ext>`, preserving the leading content-root prefix.
  // We split by the kind subdir to find the prefix.
  const ext = path.extname(oldPath); // .png / .ogg
  // oldPath ends with `<subRoot>/<oldStem><ext>`. Strip those and keep prefix.
  const suffix = `${oldStem}${ext}`;
  if (!oldPath.endsWith(suffix)) {
    // Defensive: should always end with the stem when scanner produced it.
    throw new Error(
      `fork dest: oldPath ${oldPath} does not end with stem ${oldStem}${ext}`,
    );
  }
  const prefix = oldPath.slice(0, oldPath.length - suffix.length);
  const relPath = `${prefix}${newStem}${ext}`;
  const absPath = path.join(modDir, ...relPath.split('/'));
  return { absPath, relPath };
}

export interface ForkOutcome {
  /** Final on-disk path (relative to mod root) where the upload was written. */
  relPath: string;
  /** True when the fork rewrite ran; false when the upload used the slot's existing path. */
  forked: boolean;
}

/**
 * Write `sourceAbsPath` into the slot. If the slot's path is shared with
 * other consumers, rewrite this slot's source token to a unique stem first
 * and write the file at the new path — leaving sibling slots untouched.
 */
export async function writeSlotFile(
  modDir: string,
  slotRef: AssetSlotRef,
  sourceAbsPath: string,
  allRequirements: AssetRequirement[],
): Promise<ForkOutcome> {
  const slot = allRequirements.find((r) => matchesSlot(r, slotRef));
  if (!slot) {
    throw new Error(
      `no slot matches ref ${slotRef.kind} ${slotRef.path} @ ${slotRef.sourceFile}:${slotRef.tokenOffset}`,
    );
  }

  const newStem = chooseForkStem(slot, allRequirements);
  if (newStem === null) {
    // No fork — write at the existing path.
    const dest = path.join(modDir, ...slot.path.split('/'));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(sourceAbsPath, dest);
    return { relPath: slot.path, forked: false };
  }

  // Fork: rewrite the source token, then write the file at the new path.
  await rewriteSourceToken(
    modDir,
    slot.ref.sourceFile,
    slot.ref.tokenOffset,
    slot.ref.tokenLength,
    slot.ref.sourceStem,
    newStem,
  );
  const { absPath, relPath } = destForNewStem(
    modDir,
    slot.path,
    slot.stem,
    rebuildSlotStem(slot, newStem),
  );
  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.copyFile(sourceAbsPath, absPath);
  return { relPath, forked: true };
}

/**
 * For Graphic_Multi / wornGraphicPath slots, the slot.stem includes a
 * directional / body-typed suffix beyond the sourceStem (e.g. slot.stem
 * `Apparel/Shirt/Shirt_north`, sourceStem `Apparel/Shirt/Shirt`). When the
 * sourceStem is rewritten to a new base, the slot's stem follows by keeping
 * the same suffix.
 */
function rebuildSlotStem(slot: AssetRequirement, newSourceStem: string): string {
  const oldSource = slot.ref.sourceStem;
  if (slot.stem === oldSource) return newSourceStem;
  if (slot.stem.startsWith(`${oldSource}_`)) {
    return `${newSourceStem}${slot.stem.slice(oldSource.length)}`;
  }
  // Fallback — shouldn't happen.
  return newSourceStem;
}

