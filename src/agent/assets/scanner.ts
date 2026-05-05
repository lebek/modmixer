import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type {
  AssetCounts,
  AssetFileMeta,
  AssetFilePresence,
  AssetKind,
  AssetReference,
  AssetRequirement,
  AssetScan,
  AssetSpec,
} from './types.js';
import { materializeStubs, readStubbedPaths } from './stubs.js';
import { detectGameVersionMajorMinorSync } from '../paths.js';
import { SKIP_DIRS } from '../fs-helpers.js';

interface RawRef {
  /** Stem under the kind's root, e.g. "Things/Item/Stalker" for texPath, no ext. */
  stem: string;
  kind: AssetKind;
  field: string;
  defType: string;
  defName: string;
  sourceFile: string;
  note?: string;
}

export async function scanAssets(
  modDir: string,
  gameVersion: string | null = detectGameVersionMajorMinorSync(),
): Promise<AssetScan> {
  const folder = path.basename(modDir);
  const contentRoots = resolveContentRoots(modDir, gameVersion);
  const xmlFiles: string[] = [];
  for (const root of contentRoots) {
    const defsDir = path.join(root, 'Defs');
    const found = await listFiles(defsDir, (n) => n.toLowerCase().endsWith('.xml'));
    xmlFiles.push(...found);
  }
  // C# files can live anywhere under the mod root (typically Source/, but
  // some modders put them in the root or a custom subdir).
  const csFiles = await listFiles(modDir, (n) => n.toLowerCase().endsWith('.cs'));

  const refs: RawRef[] = [];
  for (const file of xmlFiles) {
    const xml = await fsp.readFile(file, 'utf8');
    const relSource = path.relative(modDir, file).split(path.sep).join('/');
    refs.push(...extractRefs(xml, relSource, contentRoots));
  }
  for (const file of csFiles) {
    const src = await fsp.readFile(file, 'utf8');
    const relSource = path.relative(modDir, file).split(path.sep).join('/');
    refs.push(...extractCsRefs(src, relSource));
  }

  const grouped = groupRefs(refs);
  const requirements: AssetRequirement[] = [];
  for (const group of grouped.values()) {
    requirements.push(await materializeRequirement(group, modDir, contentRoots));
  }
  requirements.sort((a, b) => a.path.localeCompare(b.path));

  // Re-flag stubbed files as missing so the UI shows them as empty.
  const stubbedPaths = await readStubbedPaths(modDir);
  for (const req of requirements) {
    if (stubbedPaths.has(req.path)) {
      req.status = 'missing';
      req.stubbed = true;
      req.current = undefined;
    }
  }

  // Materialize placeholders for anything still missing so RimWorld stops
  // logging "Could not load texture/AudioClip" while the player works on
  // the real asset.
  await materializeStubs(modDir, requirements);
  // Flag the just-stubbed entries so consumers can render them correctly.
  for (const req of requirements) {
    if (req.status === 'missing' && !req.stubbed) {
      // materializeStubs wrote a file at this path, so it is now stubbed.
      req.stubbed = true;
    }
  }

  const counts = countByStatus(requirements);
  const countsByKind: Record<AssetKind, AssetCounts> = {
    texture: countByStatus(requirements.filter((r) => r.kind === 'texture')),
    icon: countByStatus(requirements.filter((r) => r.kind === 'icon')),
    audio: countByStatus(requirements.filter((r) => r.kind === 'audio')),
  };

  return { folder, requirements, counts, countsByKind };
}

/**
 * Resolve which directories under modDir act as content roots for the active
 * game version. Mirrors RimWorld's mod loading: an explicit LoadFolders.xml
 * wins; otherwise we fall back to the conventional versioned-subfolder /
 * Common / mod-root layout.
 *
 * Returned paths are absolute and ordered as they appear in LoadFolders.xml
 * (or by convention priority when LoadFolders is absent). The first entry is
 * where new placeholder files get written.
 */
function resolveContentRoots(modDir: string, gameVersion: string | null): string[] {
  const fromLoadFolders = readLoadFolders(modDir, gameVersion);
  if (fromLoadFolders) return fromLoadFolders;

  const out: string[] = [];
  if (gameVersion) {
    const versioned = path.join(modDir, gameVersion);
    if (fs.existsSync(versioned)) out.push(versioned);
  }
  const common = path.join(modDir, 'Common');
  if (fs.existsSync(common)) out.push(common);
  out.push(modDir);
  return out;
}

function readLoadFolders(modDir: string, gameVersion: string | null): string[] | null {
  const lf = path.join(modDir, 'LoadFolders.xml');
  let xml: string;
  try {
    xml = fs.readFileSync(lf, 'utf8');
  } catch {
    return null;
  }
  // Match each <v1.6>...</v1.6> style version block.
  const blockRe = /<v(\d+(?:\.\d+)?)\b[^>]*>([\s\S]*?)<\/v\1>/gi;
  const blocks = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml)) !== null) {
    blocks.set(m[1], m[2]);
  }
  if (blocks.size === 0) return null;

  let chosen = gameVersion && blocks.has(gameVersion) ? blocks.get(gameVersion) : undefined;
  if (!chosen) {
    const sorted = [...blocks.keys()].sort(compareVersionKey);
    chosen = blocks.get(sorted[sorted.length - 1]);
  }
  if (!chosen) return null;

  const liRe = /<li\b[^>]*>([^<]*)<\/li>/g;
  const out: string[] = [];
  const seen = new Set<string>();
  let li: RegExpExecArray | null;
  while ((li = liRe.exec(chosen)) !== null) {
    const entry = li[1].trim().replace(/\\/g, '/').replace(/^\/+/, '');
    const abs = entry === '' ? modDir : path.join(modDir, ...entry.split('/'));
    if (!fs.existsSync(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out.length ? out : null;
}

function compareVersionKey(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

async function listFiles(
  dir: string,
  match: (name: string) => boolean,
): Promise<string[]> {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const next = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(next, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(next, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && match(entry.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

const DEF_BLOCK_RE = /<(\w+Def)\b([^>]*)>([\s\S]*?)<\/\1>/g;
const DEF_NAME_RE = /<defName>\s*([^<\s]+)\s*<\/defName>/;
const TEX_PATH_RE = /<texPath>\s*([^<\s]+)\s*<\/texPath>/g;
const UI_ICON_PATH_RE = /<uiIconPath>\s*([^<\s]+)\s*<\/uiIconPath>/g;
const CLIP_PATH_RE = /<clipPath>\s*([^<\s]+)\s*<\/clipPath>/g;
const WORN_GRAPHIC_PATH_RE = /<wornGraphicPath>\s*([^<\s]+)\s*<\/wornGraphicPath>/g;
// RimWorld renders directional sprites as _north/_south/_east. _west is
// auto-mirrored from _east when absent.
const DIRECTIONS = ['_north', '_south', '_east'] as const;

function extractRefs(
  xml: string,
  sourceFile: string,
  contentRoots: string[],
): RawRef[] {
  const out: RawRef[] = [];
  let m: RegExpExecArray | null;
  DEF_BLOCK_RE.lastIndex = 0;
  while ((m = DEF_BLOCK_RE.exec(xml)) !== null) {
    const defType = m[1];
    const body = m[3];
    const defName = body.match(DEF_NAME_RE)?.[1] ?? '(unnamed)';

    // texPath. Field name is "graphicData.texPath" if inside <graphicData>...</graphicData>.
    for (const ref of extractTexPathRefs(body)) {
      out.push({
        stem: ref.stem,
        kind: 'texture',
        field: ref.field,
        defType,
        defName,
        sourceFile,
        note: ref.note,
      });
    }

    // uiIconPath — separate slot for the inventory/UI icon.
    let iconMatch: RegExpExecArray | null;
    UI_ICON_PATH_RE.lastIndex = 0;
    while ((iconMatch = UI_ICON_PATH_RE.exec(body)) !== null) {
      out.push({
        stem: iconMatch[1],
        kind: 'icon',
        field: 'uiIconPath',
        defType,
        defName,
        sourceFile,
        note: nearbyComment(body, iconMatch.index, iconMatch.index + iconMatch[0].length),
      });
    }

    // clipPath — only meaningful inside SoundDef-flavored defs, but we capture
    // wherever it appears since RimWorld treats them consistently as Sounds/<stem>.ogg.
    let clipMatch: RegExpExecArray | null;
    CLIP_PATH_RE.lastIndex = 0;
    while ((clipMatch = CLIP_PATH_RE.exec(body)) !== null) {
      out.push({
        stem: clipMatch[1],
        kind: 'audio',
        field: 'clipPath',
        defType,
        defName,
        sourceFile,
        note: nearbyComment(body, clipMatch.index, clipMatch.index + clipMatch[0].length),
      });
    }

    // wornGraphicPath — apparel sprites worn on pawns. The actual file pattern
    // depends on the apparel layer: body-conforming layers (OnSkin/Middle/etc.)
    // need <base>_<BodyType>_<dir>.png variants; non-body layers (Overhead/etc.)
    // just need plain <base>_<dir>.png. We can't determine the layer reliably
    // from the def alone, so we look at the on-disk reality: emit refs for
    // existing matching files. If the directory is empty (fresh scaffold), fall
    // back to plain directional so the agent has something to fill in.
    let wornMatch: RegExpExecArray | null;
    WORN_GRAPHIC_PATH_RE.lastIndex = 0;
    while ((wornMatch = WORN_GRAPHIC_PATH_RE.exec(body)) !== null) {
      const note = nearbyComment(body, wornMatch.index, wornMatch.index + wornMatch[0].length);
      const basePath = wornMatch[1];
      for (const stem of expandWornGraphicPath(basePath, contentRoots)) {
        out.push({
          stem,
          kind: 'texture',
          field: `wornGraphicPath_${stem.slice(basePath.length + 1)}`,
          defType,
          defName,
          sourceFile,
          note,
        });
      }
    }
  }
  return out;
}

/**
 * Decide which apparel sprite files this wornGraphicPath should resolve to.
 * Looks at the on-disk parent dir; if files matching `<base>_..._<dir>.png` (or
 * plain `<base>_<dir>.png`) exist, emit refs for those. Otherwise fall back to
 * the conservative directional triple — that covers fresh scaffolds with no
 * artwork yet, and avoids inventing per-body-type stems we can't verify.
 */
function expandWornGraphicPath(basePath: string, contentRoots: string[]): string[] {
  const segments = basePath.split('/').filter(Boolean);
  const baseStem = segments[segments.length - 1] ?? basePath;
  const parentSegs = segments.slice(0, -1);
  const found = new Set<string>();
  for (const root of contentRoots) {
    const dir = path.join(root, 'Textures', ...parentSegs);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.toLowerCase().endsWith('.png')) continue;
      const stem = entry.slice(0, -4);
      if (!stem.startsWith(`${baseStem}_`)) continue;
      const suffix = stem.slice(baseStem.length + 1);
      if (!isApparelSuffix(suffix)) continue;
      const relStem = [...parentSegs, stem].join('/');
      found.add(relStem);
    }
  }
  if (found.size > 0) return [...found];
  return DIRECTIONS.map((d) => `${basePath}${d}`);
}

function isApparelSuffix(suffix: string): boolean {
  // Plain directional: north / south / east
  if (/^(north|south|east)$/i.test(suffix)) return true;
  // Body-typed directional: <BodyType>_<dir>, e.g. Male_north, Hulk_east.
  if (/^[A-Za-z][A-Za-z0-9]*_(north|south|east)$/i.test(suffix)) return true;
  return false;
}

const CONTENT_FINDER_RE =
  /\bContentFinder\s*<\s*(Texture2D|AudioClip)\s*>\s*\.\s*Get\s*\(\s*"([^"\r\n]+)"/g;
const CS_CLASS_RE = /\bclass\s+(\w+)/g;

function extractCsRefs(source: string, sourceFile: string): RawRef[] {
  const out: RawRef[] = [];
  let m: RegExpExecArray | null;
  CONTENT_FINDER_RE.lastIndex = 0;
  while ((m = CONTENT_FINDER_RE.exec(source)) !== null) {
    const typeArg = m[1];
    const stem = m[2];
    const kind: AssetKind = typeArg === 'AudioClip' ? 'audio' : 'texture';
    out.push({
      stem,
      kind,
      field: `ContentFinder<${typeArg}>.Get`,
      defType: 'C#',
      defName: enclosingClass(source, m.index) ?? path.basename(sourceFile, '.cs'),
      sourceFile,
      note: nearbyCsComment(source, m.index),
    });
  }
  return out;
}

function enclosingClass(source: string, idx: number): string | undefined {
  CS_CLASS_RE.lastIndex = 0;
  let last: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = CS_CLASS_RE.exec(source)) !== null) {
    if (m.index >= idx) break;
    last = m[1];
  }
  return last;
}

// Walk back from `idx`'s line looking for a `// ...` comment that describes
// this call. Skips intermediate code lines (e.g. `static readonly Texture2D Icon =`
// preceding the ContentFinder call on the next line) up to a small lookback
// budget so we don't grab unrelated distant comments.
const COMMENT_LOOKBACK_LINES = 4;
function nearbyCsComment(source: string, idx: number): string | undefined {
  let lineEnd = source.lastIndexOf('\n', idx - 1);
  for (let i = 0; i < COMMENT_LOOKBACK_LINES; i++) {
    if (lineEnd <= 0) return undefined;
    const lineStart = source.lastIndexOf('\n', lineEnd - 1) + 1;
    const line = source.slice(lineStart, lineEnd).trim();
    if (line.startsWith('//')) {
      const text = line.replace(/^\/+\s*/, '').trim();
      return text || undefined;
    }
    if (!line) return undefined; // blank line — stop, comment isn't attached
    lineEnd = lineStart - 1;
  }
  return undefined;
}

/**
 * Look for an XML comment immediately before or after a tag span — the only
 * separation allowed is whitespace. Used to attach human descriptions to asset
 * path references like:
 *
 *   <!-- Soft thumping ambient loop, plays during anomaly events -->
 *   <clipPath>Anomaly/Ambient</clipPath>
 */
function nearbyComment(body: string, tagStart: number, tagEnd: number): string | undefined {
  // Look backwards: skip whitespace, then expect `-->` ending a comment.
  let i = tagStart - 1;
  while (i >= 0 && /\s/.test(body[i])) i--;
  if (i >= 2 && body.slice(i - 2, i + 1) === '-->') {
    const closeEnd = i + 1;
    const openIdx = body.lastIndexOf('<!--', closeEnd - 3);
    if (openIdx !== -1) {
      const inner = body.slice(openIdx + 4, closeEnd - 3).trim();
      if (inner) return inner;
    }
  }
  // Look forwards: skip whitespace, then expect `<!--`.
  let j = tagEnd;
  while (j < body.length && /\s/.test(body[j])) j++;
  if (body.startsWith('<!--', j)) {
    const closeIdx = body.indexOf('-->', j + 4);
    if (closeIdx !== -1) {
      const inner = body.slice(j + 4, closeIdx).trim();
      if (inner) return inner;
    }
  }
  return undefined;
}

function extractTexPathRefs(
  body: string,
): { stem: string; field: string; note?: string }[] {
  const out: { stem: string; field: string; note?: string }[] = [];
  // Find <graphicData>…</graphicData> blocks first, mark their texPaths, then
  // look for any remaining texPath in the body.
  const graphicSpans: Array<[number, number]> = [];
  const graphicRe = /<graphicData>([\s\S]*?)<\/graphicData>/g;
  let g: RegExpExecArray | null;
  while ((g = graphicRe.exec(body)) !== null) {
    graphicSpans.push([g.index, g.index + g[0].length]);
    const inner = g[1];
    const innerOffset = g.index + '<graphicData>'.length;
    // graphicClass controls how RimWorld interprets texPath. Default is
    // Graphic_Single (one PNG at the path). Graphic_Multi means the path is a
    // base and the actual files are _north/_south/_east. Anything else
    // (Random, Mote, Linked, …) we don't try to enumerate.
    const cls = inner.match(/<graphicClass>\s*([^<\s]+)\s*<\/graphicClass>/)?.[1];
    const isMulti = cls === 'Graphic_Multi';
    let t: RegExpExecArray | null;
    const texRe = /<texPath>\s*([^<\s]+)\s*<\/texPath>/g;
    while ((t = texRe.exec(inner)) !== null) {
      const absStart = innerOffset + t.index;
      const absEnd = absStart + t[0].length;
      const note = nearbyComment(body, absStart, absEnd);
      const base = t[1];
      if (isMulti) {
        for (const dir of DIRECTIONS) {
          out.push({
            stem: `${base}${dir}`,
            field: `graphicData.texPath${dir}`,
            note,
          });
        }
      } else {
        out.push({ stem: base, field: 'graphicData.texPath', note });
      }
    }
  }
  // Any texPath outside graphicData blocks.
  let m: RegExpExecArray | null;
  TEX_PATH_RE.lastIndex = 0;
  while ((m = TEX_PATH_RE.exec(body)) !== null) {
    const inGraphic = graphicSpans.some(([s, e]) => m!.index >= s && m!.index < e);
    if (inGraphic) continue;
    out.push({
      stem: m[1],
      field: 'texPath',
      note: nearbyComment(body, m.index, m.index + m[0].length),
    });
  }
  return out;
}

interface RefGroup {
  kind: AssetKind;
  stem: string;
  refs: AssetReference[];
}

function groupRefs(refs: RawRef[]): Map<string, RefGroup> {
  const map = new Map<string, RefGroup>();
  for (const r of refs) {
    const key = `${r.kind}::${normalizeStem(r.stem)}`;
    let g = map.get(key);
    if (!g) {
      g = { kind: r.kind, stem: normalizeStem(r.stem), refs: [] };
      map.set(key, g);
    }
    g.refs.push({
      defType: r.defType,
      defName: r.defName,
      field: r.field,
      sourceFile: r.sourceFile,
      note: r.note,
    });
  }
  return map;
}

function normalizeStem(stem: string): string {
  return stem.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.(png|ogg)$/i, '');
}

async function materializeRequirement(
  group: RefGroup,
  modDir: string,
  contentRoots: string[],
): Promise<AssetRequirement> {
  const spec = specFor(group.kind, group.refs);
  const ext = group.kind === 'audio' ? '.ogg' : '.png';
  const subRoot = group.kind === 'audio' ? 'Sounds' : 'Textures';
  const within = `${subRoot}/${group.stem}${ext}`;
  const { relPath, absPath } = resolveAssetLocation(modDir, contentRoots, within);
  const id = createHash('sha1').update(`${group.kind}::${relPath}`).digest('hex').slice(0, 16);

  const presence = await probeFile(absPath, relPath, group.kind);
  let status: AssetRequirement['status'] = 'missing';
  if (presence) {
    status = presence.issues.length ? 'invalid' : 'present';
  }

  const seen = new Set<string>();
  const notes: string[] = [];
  for (const r of group.refs) {
    if (!r.note) continue;
    const trimmed = r.note.replace(/\s+/g, ' ').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    notes.push(trimmed);
  }

  const requirement: AssetRequirement = {
    id,
    kind: group.kind,
    path: relPath,
    stem: group.stem,
    spec,
    referencedBy: group.refs,
    notes,
    status,
    current: presence ?? undefined,
  };

  if (group.kind === 'texture' && (spec as { acceptsMask: boolean }).acceptsMask) {
    const maskWithin = `${subRoot}/${group.stem}_m.png`;
    const maskLoc = resolveAssetLocation(modDir, contentRoots, maskWithin);
    const maskPresence = await probeFile(maskLoc.absPath, maskLoc.relPath, 'texture');
    requirement.mask = {
      path: maskLoc.relPath,
      status: maskPresence ? 'present' : 'missing',
      current: maskPresence ?? undefined,
    };
  }

  return requirement;
}

/**
 * Find the actual location of `<subRoot>/<stem>.<ext>` across content roots,
 * preferring an existing file. When none exists, default to the first
 * content root (where new placeholders get written).
 */
function resolveAssetLocation(
  modDir: string,
  contentRoots: string[],
  within: string,
): { relPath: string; absPath: string } {
  for (const root of contentRoots) {
    const abs = path.join(root, ...within.split('/'));
    if (fs.existsSync(abs)) {
      return { absPath: abs, relPath: toModRelative(modDir, abs) };
    }
  }
  const abs = path.join(contentRoots[0], ...within.split('/'));
  return { absPath: abs, relPath: toModRelative(modDir, abs) };
}

function toModRelative(modDir: string, abs: string): string {
  return path.relative(modDir, abs).split(path.sep).join('/');
}

function specFor(kind: AssetKind, refs: AssetReference[]): AssetSpec {
  if (kind === 'audio') {
    return {
      kind: 'audio',
      format: 'ogg',
      description: 'Ogg Vorbis audio clip referenced by a SoundDef. Mono is preferred for in-game positional sound.',
    };
  }
  if (kind === 'icon') {
    return {
      kind: 'icon',
      format: 'png',
      acceptsMask: false,
      description: 'PNG icon shown in inventory and UI. Square is recommended.',
      sizeHint: '64×64 PNG, transparent background',
    };
  }
  // texture
  const usedInGraphicData = refs.some((r) => r.field.startsWith('graphicData.texPath'));
  const usedAsApparel = refs.some((r) => r.field.startsWith('wornGraphicPath'));
  const usedFromCs = refs.some((r) => r.field.startsWith('ContentFinder<'));
  let description: string;
  if (usedAsApparel) {
    description =
      'Directional apparel sprite worn on pawns. _west.png is auto-mirrored from _east.png if absent.';
  } else if (usedInGraphicData) {
    description =
      'PNG sprite rendered in-world via graphicData. Power-of-two dimensions preferred.';
  } else if (usedFromCs) {
    description =
      'PNG loaded from C# code (gizmo, designator, MainTabWindow icon, etc.).';
  } else {
    description = 'PNG sprite. Power-of-two dimensions preferred.';
  }
  return {
    kind: 'texture',
    format: 'png',
    acceptsMask: usedInGraphicData || usedAsApparel,
    description,
    sizeHint: '64×64 / 128×128 / 256×256 PNG with transparency',
  };
}

async function probeFile(
  absPath: string,
  relPath: string,
  kind: AssetKind,
): Promise<AssetFilePresence | null> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const meta: AssetFileMeta = { size: stat.size };
  const issues: string[] = [];

  let buf: Buffer;
  try {
    const fh = await fsp.open(absPath, 'r');
    try {
      // Read first 32 bytes for sniffing — enough for PNG IHDR and Ogg magic.
      const head = Buffer.alloc(32);
      await fh.read(head, 0, 32, 0);
      buf = head;
    } finally {
      await fh.close();
    }
  } catch {
    return { path: relPath, absPath, meta, issues: ['could not read file'] };
  }

  if (kind === 'audio') {
    if (!isOgg(buf)) {
      issues.push('not a valid Ogg file');
      meta.detectedFormat = sniffFormat(buf);
    } else {
      meta.detectedFormat = 'ogg';
    }
  } else {
    if (!isPng(buf)) {
      issues.push('not a valid PNG file');
      meta.detectedFormat = sniffFormat(buf);
    } else {
      meta.detectedFormat = 'png';
      const dims = readPngDims(buf);
      if (dims) {
        meta.width = dims.width;
        meta.height = dims.height;
      }
    }
  }

  return { path: relPath, absPath, meta, issues };
}

function isPng(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  return (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  );
}

function isOgg(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53;
}

function readPngDims(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function sniffFormat(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 6 && buf.slice(0, 6).toString() === 'GIF87a') return 'gif';
  if (buf.length >= 6 && buf.slice(0, 6).toString() === 'GIF89a') return 'gif';
  if (buf.length >= 4 && buf.slice(0, 4).toString() === 'RIFF') return 'wav-or-webp';
  return 'unknown';
}

function countByStatus(reqs: AssetRequirement[]): AssetCounts {
  const counts: AssetCounts = { missing: 0, invalid: 0, present: 0 };
  for (const r of reqs) counts[r.status] += 1;
  return counts;
}
