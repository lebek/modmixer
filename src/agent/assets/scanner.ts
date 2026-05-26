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
  VanillaSource,
} from './types.js';
import { materializeStubs, readStubbedPaths } from './stubs.js';
import { detectGameVersionMajorMinorSync, detectRimWorldPaths } from '../paths.js';
import { SKIP_DIRS } from '../fs-helpers.js';
import { getVanillaPathIndex, lookupVanilla } from './vanilla-paths.js';
import {
  CS_MANIFEST_REL,
  driftWarnings,
  extractCsLiterals,
  loadCsManifest,
  type LoadedCsManifest,
} from './cs-manifest.js';

/**
 * A single raw ref site discovered in the mod's source. One ref = one slot in
 * the UI; we never group across (defType, defName, field, sourceFile, offset).
 * Two defs pointing at the same texPath produce two RawRefs and two slots; the
 * upload IPC auto-forks on demand.
 */
interface RawRef {
  /** Stem under the kind's root, e.g. "Things/Item/Stalker" for texPath, no ext. */
  stem: string;
  kind: AssetKind;
  field: string;
  defType: string;
  defName: string;
  /** Def's <label> (XML) or variable name assigned the call (C#). */
  label?: string;
  sourceFile: string;
  /** Byte offset of the originating XML tag / C# call within the source file. */
  tokenOffset: number;
  tokenLength: number;
  /** The path as written in the token — same as stem for plain refs, BASE for Graphic_Multi / wornGraphicPath expansions. */
  sourceStem: string;
}

export async function scanAssets(
  modDir: string,
  gameVersion: string | null = detectGameVersionMajorMinorSync(),
  /**
   * Base-game install Data/ folder. Optional so unit tests can omit it; the
   * production caller (assets IPC) passes detectRimWorldPaths().dataDir so the
   * scanner can resolve vanilla fallbacks.
   */
  dataDir: string | null = detectRimWorldPaths().dataDir,
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
  // C# slots come from the .modmixer/cs-assets.json manifest, not by
  // regex-scanning .cs files. The agent declares paths there because
  // ContentFinder calls can carry consts or other indirections the scanner
  // can't follow. We still glance at .cs literals below to flag drift.
  const csManifest = await loadCsManifest(modDir);
  for (const entry of csManifest.entries) {
    refs.push(refFromCsManifestEntry(entry));
  }

  // Read the existing stub manifest before building requirements so paths
  // whose on-disk file is a known placeholder get treated as missing (and
  // vanilla-fallback resolution runs for them).
  const stubbedBefore = await readStubbedPaths(modDir);
  const vanillaIndex = getVanillaPathIndex(dataDir);
  const requirements: AssetRequirement[] = [];
  for (const r of refs) {
    requirements.push(
      await materializeRequirement(r, modDir, contentRoots, vanillaIndex, stubbedBefore),
    );
  }
  // Sort by on-disk path, then by defName so siblings sharing a path land
  // together in the UI.
  requirements.sort((a, b) => {
    const p = a.path.localeCompare(b.path);
    if (p !== 0) return p;
    return a.ref.defName.localeCompare(b.ref.defName);
  });

  // Materialize placeholders for anything still missing — but only when the
  // path has no vanilla fallback. Stubbing over a vanilla path would shadow
  // Core/DLC art at runtime. Clean up orphan stubs as a side effect.
  await materializeStubs(modDir, requirements);
  const stubbedAfter = await readStubbedPaths(modDir);
  for (const req of requirements) {
    if (stubbedAfter.has(req.path)) {
      req.stubbed = true;
    } else {
      req.stubbed = undefined;
    }
  }

  const counts = countByStatus(requirements);
  const countsByKind: Record<AssetKind, AssetCounts> = {
    texture: countByStatus(requirements.filter((r) => r.kind === 'texture')),
    icon: countByStatus(requirements.filter((r) => r.kind === 'icon')),
    audio: countByStatus(requirements.filter((r) => r.kind === 'audio')),
  };

  const warnings = await computeWarnings(modDir, csFiles, csManifest);

  return { folder, requirements, counts, countsByKind, warnings };
}

/**
 * Drift backstop. Only runs when we have either a manifest or some literals
 * in code — otherwise there's nothing to compare and silence is correct.
 */
async function computeWarnings(
  modDir: string,
  csFiles: string[],
  manifest: LoadedCsManifest,
): Promise<string[]> {
  if (csFiles.length === 0 && manifest.entries.length === 0) return [];
  const literalsByFile = await collectCsLiterals(modDir, csFiles);
  return driftWarnings(manifest, literalsByFile);
}

/**
 * Resolve which directories under modDir act as content roots for the active
 * game version. Mirrors RimWorld's mod loading: an explicit LoadFolders.xml
 * wins; otherwise we fall back to the conventional versioned-subfolder /
 * Common / mod-root layout.
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
// <label> is the player-facing display name. Used as the slot title in the
// asset browser when present so a vanilla path (e.g. "BowShort") still reads
// as the modder's item name (e.g. "vine bow").
const DEF_LABEL_RE = /<label>\s*([^<]*?)\s*<\/label>/;
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
    const bodyOffset = m.index + m[0].indexOf(body);
    const defName = body.match(DEF_NAME_RE)?.[1] ?? '(unnamed)';
    const labelRaw = body.match(DEF_LABEL_RE)?.[1]?.trim();
    const label = labelRaw && labelRaw.length > 0 ? labelRaw : undefined;

    // texPath — handled separately because graphicData context changes
    // expansion (Graphic_Multi → 3 directional sprites).
    for (const ref of extractTexPathRefs(body, bodyOffset)) {
      out.push({
        stem: ref.stem,
        kind: 'texture',
        field: ref.field,
        defType,
        defName,
        label,
        sourceFile,
        tokenOffset: ref.tokenOffset,
        tokenLength: ref.tokenLength,
        sourceStem: ref.sourceStem,
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
        label,
        sourceFile,
        tokenOffset: bodyOffset + iconMatch.index,
        tokenLength: iconMatch[0].length,
        sourceStem: iconMatch[1],
      });
    }

    // clipPath — meaningful inside SoundDef-flavored defs.
    let clipMatch: RegExpExecArray | null;
    CLIP_PATH_RE.lastIndex = 0;
    while ((clipMatch = CLIP_PATH_RE.exec(body)) !== null) {
      out.push({
        stem: clipMatch[1],
        kind: 'audio',
        field: 'clipPath',
        defType,
        defName,
        label,
        sourceFile,
        tokenOffset: bodyOffset + clipMatch.index,
        tokenLength: clipMatch[0].length,
        sourceStem: clipMatch[1],
      });
    }

    // wornGraphicPath — apparel sprites worn on pawns. One `<wornGraphicPath>`
    // tag expands to 3 directional refs (and possibly body-typed siblings if
    // those files exist on disk). All expansions share the same tokenOffset
    // and sourceStem — a fork rewrite touches the single source tag and moves
    // every expansion with it.
    let wornMatch: RegExpExecArray | null;
    WORN_GRAPHIC_PATH_RE.lastIndex = 0;
    while ((wornMatch = WORN_GRAPHIC_PATH_RE.exec(body)) !== null) {
      const basePath = wornMatch[1];
      const offset = bodyOffset + wornMatch.index;
      const length = wornMatch[0].length;
      for (const stem of expandWornGraphicPath(basePath, contentRoots)) {
        out.push({
          stem,
          kind: 'texture',
          field: `wornGraphicPath_${stem.slice(basePath.length + 1)}`,
          defType,
          defName,
          label,
          sourceFile,
          tokenOffset: offset,
          tokenLength: length,
          sourceStem: basePath,
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
 * the conservative directional triple.
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
  if (/^(north|south|east)$/i.test(suffix)) return true;
  if (/^[A-Za-z][A-Za-z0-9]*_(north|south|east)$/i.test(suffix)) return true;
  return false;
}

/**
 * Build a RawRef from one entry in the C# asset manifest. The "source file"
 * is the manifest itself — the fork rewriter edits the quoted path string
 * in place when this slot's path collides with a sibling.
 */
function refFromCsManifestEntry(entry: {
  kind: AssetKind;
  stem: string;
  tokenOffset: number;
  tokenLength: number;
}): RawRef {
  // Trailing segment of the path becomes both defName (when no label is
  // available) and the title fallback. Keep it simple — the agent's lore
  // already pushes them to pick descriptive stems.
  const lastSegment = entry.stem.split('/').pop() ?? entry.stem;
  return {
    stem: entry.stem,
    kind: entry.kind,
    field: 'cs-asset',
    defType: 'C#',
    defName: lastSegment,
    sourceFile: CS_MANIFEST_REL,
    tokenOffset: entry.tokenOffset,
    tokenLength: entry.tokenLength,
    sourceStem: entry.stem,
  };
}

/**
 * Walk .cs files for the literal-string subset of ContentFinder calls so we
 * can warn about drift between code and the manifest. This is NOT a source
 * of slots — the manifest is the only source. We're just sanity-checking
 * that the agent's manifest matches the literals they wrote (or noting that
 * a literal isn't tracked anywhere).
 */
async function collectCsLiterals(
  modDir: string,
  csFiles: string[],
): Promise<Array<{ sourceFile: string; literals: ReturnType<typeof extractCsLiterals> }>> {
  const out: Array<{ sourceFile: string; literals: ReturnType<typeof extractCsLiterals> }> = [];
  for (const file of csFiles) {
    const src = await fsp.readFile(file, 'utf8');
    const literals = extractCsLiterals(src);
    if (literals.length === 0) continue;
    const relSource = path.relative(modDir, file).split(path.sep).join('/');
    out.push({ sourceFile: relSource, literals });
  }
  return out;
}

interface TexPathExtraction {
  stem: string;
  field: string;
  tokenOffset: number;
  tokenLength: number;
  sourceStem: string;
}

function extractTexPathRefs(body: string, bodyOffset: number): TexPathExtraction[] {
  const out: TexPathExtraction[] = [];
  const graphicSpans: Array<[number, number]> = [];
  const graphicRe = /<graphicData>([\s\S]*?)<\/graphicData>/g;
  let g: RegExpExecArray | null;
  while ((g = graphicRe.exec(body)) !== null) {
    graphicSpans.push([g.index, g.index + g[0].length]);
    const inner = g[1];
    const innerOffset = g.index + '<graphicData>'.length;
    const cls = inner.match(/<graphicClass>\s*([^<\s]+)\s*<\/graphicClass>/)?.[1];
    const isMulti = cls === 'Graphic_Multi';
    let t: RegExpExecArray | null;
    const texRe = /<texPath>\s*([^<\s]+)\s*<\/texPath>/g;
    while ((t = texRe.exec(inner)) !== null) {
      const tokenOffset = bodyOffset + innerOffset + t.index;
      const tokenLength = t[0].length;
      const base = t[1];
      if (isMulti) {
        for (const dir of DIRECTIONS) {
          out.push({
            stem: `${base}${dir}`,
            field: `graphicData.texPath${dir}`,
            tokenOffset,
            tokenLength,
            sourceStem: base,
          });
        }
      } else {
        out.push({
          stem: base,
          field: 'graphicData.texPath',
          tokenOffset,
          tokenLength,
          sourceStem: base,
        });
      }
    }
  }
  // texPath outside graphicData blocks.
  let m: RegExpExecArray | null;
  TEX_PATH_RE.lastIndex = 0;
  while ((m = TEX_PATH_RE.exec(body)) !== null) {
    const inGraphic = graphicSpans.some(([s, e]) => m!.index >= s && m!.index < e);
    if (inGraphic) continue;
    out.push({
      stem: m[1],
      field: 'texPath',
      tokenOffset: bodyOffset + m.index,
      tokenLength: m[0].length,
      sourceStem: m[1],
    });
  }
  return out;
}

function normalizeStem(stem: string): string {
  return stem.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.(png|ogg)$/i, '');
}

async function materializeRequirement(
  raw: RawRef,
  modDir: string,
  contentRoots: string[],
  vanillaIndex: ReturnType<typeof getVanillaPathIndex>,
  stubbedPaths: Set<string>,
): Promise<AssetRequirement> {
  const stem = normalizeStem(raw.stem);
  const spec = specFor(raw.kind, raw.field);
  const ext = raw.kind === 'audio' ? '.ogg' : '.png';
  const subRoot = raw.kind === 'audio' ? 'Sounds' : 'Textures';
  const within = `${subRoot}/${stem}${ext}`;
  const { relPath, absPath } = resolveAssetLocation(modDir, contentRoots, within);

  // id encodes everything that uniquely identifies a slot — including the
  // token offset so two refs from the same XML tag (Graphic_Multi expansion)
  // remain distinct cards while sharing the on-disk file.
  const id = createHash('sha1')
    .update(
      [
        raw.kind,
        relPath,
        raw.sourceFile,
        raw.defType,
        raw.defName,
        raw.field,
        raw.tokenOffset,
      ].join('::'),
    )
    .digest('hex')
    .slice(0, 16);

  const presence = await probeFile(absPath, relPath, raw.kind);
  // A file that matches a known stub-manifest hash is conceptually missing —
  // hide it from the UI as a real present file and let vanilla resolution run.
  const isStub = !!presence && stubbedPaths.has(relPath);
  const effective = isStub ? null : presence;

  let status: AssetRequirement['status'] = 'missing';
  if (effective) status = effective.issues.length ? 'invalid' : 'present';

  // Vanilla detection: the stem comes from a vanilla def (loose XML under
  // Data/<pack>/Defs). The actual file is bundled in Unity asset archives so
  // we can't preview it — but knowing the path is vanilla lets the stub
  // system skip it (no magenta-shadow-Core) and lets the UI tell the user
  // "this resolves to vanilla art".
  let vanilla: VanillaSource | undefined;
  if (!effective) {
    const pack = lookupVanilla(vanillaIndex, raw.kind, stem);
    if (pack) vanilla = { pack };
  }

  const ref: AssetReference = {
    defType: raw.defType,
    defName: raw.defName,
    label: raw.label,
    field: raw.field,
    sourceFile: raw.sourceFile,
    tokenOffset: raw.tokenOffset,
    tokenLength: raw.tokenLength,
    sourceStem: raw.sourceStem,
  };

  const requirement: AssetRequirement = {
    id,
    kind: raw.kind,
    path: relPath,
    stem,
    spec,
    ref,
    status,
    current: effective ?? undefined,
    vanilla,
  };

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

function specFor(kind: AssetKind, _field: string): AssetSpec {
  if (kind === 'audio') {
    return { kind: 'audio', format: 'ogg' };
  }
  if (kind === 'icon') {
    return {
      kind: 'icon',
      format: 'png',
      sizeHint: '64×64 PNG, transparent background',
    };
  }
  return {
    kind: 'texture',
    format: 'png',
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
