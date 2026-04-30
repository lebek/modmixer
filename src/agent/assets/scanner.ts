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

const SKIP_DIRS = new Set(['.git', '.DS_Store', '.vs', 'bin', 'obj', 'node_modules']);

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

export async function scanAssets(modDir: string): Promise<AssetScan> {
  const folder = path.basename(modDir);
  const defsDir = path.join(modDir, 'Defs');
  const xmlFiles = await listXmlFiles(defsDir);

  const refs: RawRef[] = [];
  for (const file of xmlFiles) {
    const xml = await fsp.readFile(file, 'utf8');
    const relSource = path.relative(modDir, file).split(path.sep).join('/');
    refs.push(...extractRefs(xml, relSource));
  }

  const grouped = groupRefs(refs);
  const requirements: AssetRequirement[] = [];
  for (const group of grouped.values()) {
    requirements.push(await materializeRequirement(group, modDir));
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

async function listXmlFiles(dir: string): Promise<string[]> {
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
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) {
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

function extractRefs(xml: string, sourceFile: string): RawRef[] {
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
  }
  return out;
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
    let t: RegExpExecArray | null;
    const texRe = /<texPath>\s*([^<\s]+)\s*<\/texPath>/g;
    while ((t = texRe.exec(inner)) !== null) {
      const absStart = innerOffset + t.index;
      const absEnd = absStart + t[0].length;
      out.push({
        stem: t[1],
        field: 'graphicData.texPath',
        note: nearbyComment(body, absStart, absEnd),
      });
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
): Promise<AssetRequirement> {
  const spec = specFor(group.kind, group.refs);
  const ext = group.kind === 'audio' ? '.ogg' : '.png';
  const root = group.kind === 'audio' ? 'Sounds' : 'Textures';
  const relPath = `${root}/${group.stem}${ext}`;
  const absPath = path.join(modDir, ...relPath.split('/'));
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
    const maskRel = `${root}/${group.stem}_m.png`;
    const maskAbs = path.join(modDir, ...maskRel.split('/'));
    const maskPresence = await probeFile(maskAbs, maskRel, 'texture');
    requirement.mask = {
      path: maskRel,
      status: maskPresence ? 'present' : 'missing',
      current: maskPresence ?? undefined,
    };
  }

  return requirement;
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
  const usedInGraphicData = refs.some((r) => r.field === 'graphicData.texPath');
  return {
    kind: 'texture',
    format: 'png',
    acceptsMask: usedInGraphicData,
    description: usedInGraphicData
      ? 'PNG sprite rendered in-world via graphicData. Power-of-two dimensions preferred.'
      : 'PNG sprite. Power-of-two dimensions preferred.',
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
