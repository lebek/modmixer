import path from 'node:path';
import fs from 'node:fs';
import { SKIP_DIRS } from '../fs-helpers.js';

/**
 * The set of asset path stems that RimWorld's loose vanilla defs reference,
 * grouped by kind. Built once per `dataDir` (per process) by walking every
 * `Data/<pack>/Defs/**\/*.xml` file and regex-extracting the same path tags
 * the mod scanner pulls out.
 *
 * Why this exists: RimWorld bundles its actual `.png`/`.ogg` files into
 * Unity asset archives — we can't probe them on disk. But the *defs* that
 * reference them are loose XML, so we can build a manifest of which stems
 * the engine considers "vanilla". A mod that points at one of those stems
 * resolves at runtime against Core/DLC's bundled art; modmixer must NOT
 * write a magenta-checker stub at that path or it would shadow the bundled
 * art (mods load after Core).
 *
 * The map is keyed by stem (path without ext) → pack name. Multiple packs
 * can reference the same stem (a DLC reusing a Core path); we keep the
 * first one we see — only used for display/diagnostics.
 */
export interface VanillaPathIndex {
  /** stem → pack name that ships it. */
  textures: Map<string, string>;
  audio: Map<string, string>;
}

const CACHE = new Map<string, VanillaPathIndex>();

/**
 * Resolve the vanilla-path index for a given `dataDir`. Synchronous + cached:
 * the first call walks the tree (thousands of files on a full RimWorld
 * install, takes ~100-300ms), subsequent calls return the cached result.
 *
 * Pass null to opt out (returns an empty index — used by tests / when the
 * game isn't installed). The cache key is the canonicalized dataDir path.
 */
export function getVanillaPathIndex(dataDir: string | null): VanillaPathIndex {
  if (!dataDir) return emptyIndex();
  const key = path.resolve(dataDir);
  const cached = CACHE.get(key);
  if (cached) return cached;
  const built = buildIndex(key);
  CACHE.set(key, built);
  return built;
}

/** Test/debug hook — drop the in-process cache so the next call rebuilds. */
export function clearVanillaPathIndexCache(): void {
  CACHE.clear();
}

function emptyIndex(): VanillaPathIndex {
  return { textures: new Map(), audio: new Map() };
}

function buildIndex(dataDir: string): VanillaPathIndex {
  const out = emptyIndex();
  let packs: fs.Dirent[];
  try {
    packs = fs.readdirSync(dataDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const pack of packs) {
    if (!pack.isDirectory()) continue;
    const defsDir = path.join(dataDir, pack.name, 'Defs');
    if (!fs.existsSync(defsDir)) continue;
    scanDefsDir(defsDir, pack.name, out);
  }
  return out;
}

// Matches the same path tags the mod scanner pulls out. Capture group 1 is
// the path text. Each tag-kind is associated with a target Map.
const TEXTURE_TAGS: Array<{ re: RegExp; map: 'textures' }> = [
  { re: /<texPath>\s*([^<\s]+)\s*<\/texPath>/g, map: 'textures' },
  { re: /<uiIconPath>\s*([^<\s]+)\s*<\/uiIconPath>/g, map: 'textures' },
  { re: /<wornGraphicPath>\s*([^<\s]+)\s*<\/wornGraphicPath>/g, map: 'textures' },
];
const AUDIO_TAGS: Array<{ re: RegExp; map: 'audio' }> = [
  { re: /<clipPath>\s*([^<\s]+)\s*<\/clipPath>/g, map: 'audio' },
];

function scanDefsDir(defsDir: string, pack: string, out: VanillaPathIndex): void {
  const stack: string[] = [defsDir];
  while (stack.length) {
    const next = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(next, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(next, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.xml')) continue;
      let xml: string;
      try {
        xml = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      collectStems(xml, pack, out);
    }
  }
}

function collectStems(xml: string, pack: string, out: VanillaPathIndex): void {
  for (const { re } of TEXTURE_TAGS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const stem = normalize(m[1]);
      if (!stem) continue;
      if (!out.textures.has(stem)) out.textures.set(stem, pack);
    }
  }
  for (const { re } of AUDIO_TAGS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const stem = normalize(m[1]);
      if (!stem) continue;
      if (!out.audio.has(stem)) out.audio.set(stem, pack);
    }
  }
}

function normalize(stem: string): string {
  return stem.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.(png|ogg)$/i, '');
}

/**
 * Decide whether a stem resolves to vanilla art. For Graphic_Multi /
 * wornGraphicPath stems the mod scanner has already appended `_north/_south/
 * _east` (or body-typed) — vanilla refs are written as the BASE, so we strip
 * a known directional suffix before checking. If either the full stem or
 * the directional base matches, the path is considered vanilla.
 */
export function lookupVanilla(
  index: VanillaPathIndex,
  kind: 'texture' | 'icon' | 'audio',
  stem: string,
): string | undefined {
  const map = kind === 'audio' ? index.audio : index.textures;
  const direct = map.get(stem);
  if (direct) return direct;
  // Try stripping a directional / body-typed suffix.
  const dir = stem.match(/^(.+?)(?:_[A-Za-z][A-Za-z0-9]*)?_(north|south|east|west)$/i);
  if (dir) {
    const base = dir[1];
    const fromBase = map.get(base);
    if (fromBase) return fromBase;
  }
  return undefined;
}
