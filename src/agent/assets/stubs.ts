import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import type { AssetKind, AssetRequirement } from './types.js';

// Sidecar manifest path (relative to mod root).
const MANIFEST_REL = '.modmixer/stubs.json';

interface StubManifestEntry {
  path: string;
  kind: AssetKind;
  sha256: string;
  generatedAt: string;
}

interface StubManifest {
  version: 1;
  entries: StubManifestEntry[];
}

// 100ms mono Vorbis silence, ~3.4KB. Inlined to avoid resourcesPath plumbing.
const SILENT_OGG_B64 =
  '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GGGOMOcYYE4055xxzzkHnHISMOcacc06iypxzzjnInIOOQuacc85BCKGEUgEA4AYHAIAAGzQlFmcpVJS08NCQFQFAFAAAYQxiSimllFKsGINKKaaUUkop5RhVijGmlFJKKaUYY0wppZRSSimlGGNMKaWUUkoppRRjTCmllFJKKaUUY4wppZRSSimllGKMKaWUUkoppZRSjDGllFJKKaWUUooxppRSSimllFJKKcaYUkoppZRSSinGGFNKKaWUUkoppRhjSimllFJKKaWUYowppZRSSimllFKMMaWUUkoppZRSijGmlFJKKaWUUooxppRSSimllFJKKQAA4AYOAAARjKi0UDsLOvE4ApWGrAQAcgAAQAhSjDHFkFKKKcgYg9BJqJiCDDLIqGIKMsccQ8oxBplzjjGFlGOMOcOQUcw5xxRDijHFGGOOQUepUkw5xZRjjDHHFKOOMcWcY4w5x5xjzjnGnFNMQemcg85B6CCEzkHoIITQQQgdhFAAAOAEBwCAACOiTLA4SkmwjOAVjyVRBQ4NWQkAJAEAEMQYY4w5JyVTSjnnIGNOQiaVUso5BplzEjKolFLOOcicg5JBpZRyzjnoHJSOOaWUcg46qJxz0jHFlGLMOemcM48xxBhTjDnnIGOMMcYUY4wpxJyDjjkIHXPSMcWUUowxxhxjjDHGGGOMOcUYY4wxxxxjzCnEFGOOMQYZcwwphRRjzjmGqHNQAQAQAQ4AAAEmVCgkPNJUtKAjT0ULOvI0dKQjDQAAAACAAAACAQADBAUlFAUjk5MAAQEFCBQUFBQNCAQDBwYHCAYGCAYHCxMOCgwTDxQNDQ8VHRoREhUcGRsPDhwbHhwfFRoaGhoVDR0aHRofHB0eHRYbGSAYHB0bHhcZGRsdGhYWHRgZGRkaGRkVDx4eHRsbGhoYDQ0PFRkZHA0NDxIWGRgYGAwMDhAVFhkPDg8RFRgZGAwMDg8UFRgPDQ4QFBoZGBcLCw0PFBgYGgsLDQ8VGhgaCAgKCxIVFhYICAsNFBYWGAgGCAsRFBYYBwYHCQ8VFhcGBgcKEhYWFwYHCAoUFhYbBgcKDxYWFhYHCAwTFRYWGggMEhUVFhYIDhIVFhYWFhMVFRYWFhUVFhUUExUWGAgGCQsNDg4PCQwLDhIPDgkLDA0NEA8NCAcKDA0NDg4ODw8PDw0NDQ4PDwwLCw0NDQ8PDw0LBwsNDQ4PDw8NDQwLBgYHCQoMDQ8PDQ4LCgsHCQwLCwwODg8ODg0LCwsLCwwODg4ODw0KDA8MDxAQDw0NDQ8PDg8MDQ8PDw4PDgwNDQ8MDw8PDw0NDA0NDQ4PDg4MDQ4MDw4PDw4OCw0LDQ0ODw8PDw4ODg4ODg4LCgsKDQ0PDw8PDg4MDg4MDg4MCwsLCw0NDQ4ODg4PDw0NDgwNCgsLCw0NDg4ODg4ODg0NDQ0LCwsLCw0NDg4PDg4ODg4OCgwODw0PEBAQDw0NDQ4PDw4PDw4ODw4PEBAPDw8PDw4ODg8PDg8ODg4ODw8PDw0ODg4ODg4PDw4ODg4OCwwNDQ4ODg4ODg4OCwsNDA4ODg4ODg4ODg0NDA0NDg4PDw8PDw8PDg4ODg4ODg4ODg4ODg4ODg0NDw8PDw8PDw0NDg4ODg4ODg4ODg4ODg4ODg4ODg4ODg0NDw8PDw8PDw==';

// Magenta-checker PNG, 64x64, 16-px squares. Generated once and cached.
let magentaCheckerPng: Buffer | null = null;
function magentaCheckerPngBuffer(): Buffer {
  if (magentaCheckerPng) return magentaCheckerPng;
  const W = 64;
  const H = 64;
  const SQ = 16;
  // Raw scanlines: each row prefixed by filter byte 0, then RGB triples.
  const rowBytes = 1 + W * 3;
  const raw = Buffer.alloc(rowBytes * H);
  for (let y = 0; y < H; y++) {
    raw[y * rowBytes] = 0;
    for (let x = 0; x < W; x++) {
      const isMagenta = (Math.floor(x / SQ) + Math.floor(y / SQ)) % 2 === 0;
      const off = y * rowBytes + 1 + x * 3;
      raw[off] = isMagenta ? 0xff : 0x00;
      raw[off + 1] = 0x00;
      raw[off + 2] = isMagenta ? 0xff : 0x00;
    }
  }
  const idat = zlib.deflateSync(raw);

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  magentaCheckerPng = Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return magentaCheckerPng;
}

// CRC32 table for PNG chunks.
let crcTable: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

let silentOgg: Buffer | null = null;
function silentOggBuffer(): Buffer {
  if (!silentOgg) silentOgg = Buffer.from(SILENT_OGG_B64, 'base64');
  return silentOgg;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function readManifest(modDir: string): Promise<StubManifest> {
  const abs = path.join(modDir, MANIFEST_REL);
  try {
    const txt = await fsp.readFile(abs, 'utf8');
    const parsed = JSON.parse(txt) as StubManifest;
    if (parsed.version === 1 && Array.isArray(parsed.entries)) return parsed;
  } catch {
    // fall through
  }
  return { version: 1, entries: [] };
}

async function writeManifest(modDir: string, manifest: StubManifest): Promise<void> {
  const abs = path.join(modDir, MANIFEST_REL);
  const next = JSON.stringify(manifest, null, 2) + '\n';
  try {
    const existing = await fsp.readFile(abs, 'utf8');
    if (existing === next) return;
  } catch {
    // doesn't exist yet — fall through and write
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, next, 'utf8');
}

function bufferForKind(kind: AssetKind): Buffer {
  if (kind === 'audio') return silentOggBuffer();
  return magentaCheckerPngBuffer();
}

/**
 * Materialize placeholder files for missing requirements so RimWorld stops
 * logging "Could not load texture/AudioClip". The scanner will still report
 * them as `missing` (the manifest tags them as stubs).
 *
 * Returns the updated manifest. Idempotent — only writes files that are
 * absent or whose hash differs from the canonical stub.
 */
export async function materializeStubs(
  modDir: string,
  requirements: AssetRequirement[],
): Promise<StubManifest> {
  const manifest = await readManifest(modDir);
  const known = new Map(manifest.entries.map((e) => [e.path, e]));
  const stillNeeded = new Set<string>();

  for (const req of requirements) {
    if (req.status !== 'missing') continue;
    const buf = bufferForKind(req.kind);
    const hash = sha256(buf);
    const abs = path.join(modDir, ...req.path.split('/'));

    let needWrite = true;
    try {
      const existing = await fsp.readFile(abs);
      if (sha256(existing) === hash) needWrite = false;
    } catch {
      needWrite = true;
    }

    if (needWrite) {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, buf);
    }

    stillNeeded.add(req.path);
    known.set(req.path, {
      path: req.path,
      kind: req.kind,
      sha256: hash,
      generatedAt: known.get(req.path)?.generatedAt ?? new Date().toISOString(),
    });
  }

  // Drop stubs that are no longer needed (real file landed, or def removed).
  // If the file on disk still matches our stub hash AND nothing references it
  // anymore, delete it so the player isn't shipping placeholders.
  for (const [relPath, entry] of [...known]) {
    if (stillNeeded.has(relPath)) continue;
    const abs = path.join(modDir, ...relPath.split('/'));
    try {
      const buf = await fsp.readFile(abs);
      if (sha256(buf) === entry.sha256) {
        await fsp.unlink(abs);
      }
    } catch {
      // already gone
    }
    known.delete(relPath);
  }

  const next: StubManifest = { version: 1, entries: [...known.values()] };
  await writeManifest(modDir, next);
  return next;
}

/**
 * Returns the set of mod-relative paths whose on-disk content matches a stub
 * recorded in the manifest. Used by the scanner to flag files as "stubbed"
 * so the UI can render them as missing.
 */
export async function readStubbedPaths(modDir: string): Promise<Set<string>> {
  const manifest = await readManifest(modDir);
  const out = new Set<string>();
  for (const entry of manifest.entries) {
    const abs = path.join(modDir, ...entry.path.split('/'));
    try {
      const buf = await fsp.readFile(abs);
      if (sha256(buf) === entry.sha256) out.add(entry.path);
    } catch {
      // missing on disk — manifest is stale, ignore.
    }
  }
  return out;
}

/** Delete every placeholder file we generated and clear the manifest. */
export async function clearStubs(modDir: string): Promise<void> {
  const manifest = await readManifest(modDir);
  for (const entry of manifest.entries) {
    const abs = path.join(modDir, ...entry.path.split('/'));
    try {
      const buf = await fsp.readFile(abs);
      if (sha256(buf) === entry.sha256) await fsp.unlink(abs);
    } catch {
      // ignore
    }
  }
  try {
    await fsp.unlink(path.join(modDir, MANIFEST_REL));
  } catch {
    // ignore
  }
}
