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

// 0.5s mono 22050Hz Vorbis silence, ~3.4KB. Inlined to avoid resourcesPath plumbing.
// Generated with `oggenc` so the stream has a real audio packet and an EOS-marked
// final page — FMOD rejects truncated streams with "Unsupported file or audio format".
const SILENT_OGG_B64 =
  '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UowJAAAYcAAACDChDBQasiIAiAIAAJxzzjnnnHPOOeecc84555xzzjnnGGOMMcYYY4wxxhhjjDHGGGOMMcYYY4wxxhhjjDHGBADsRDgA7ERYCIWGrAQAwgEAAIQUgpJSKaWUEjnnpJRSSimllMhBCKWUUkoppUTSSSmllFJKKaVxUEoppZRSSimhlFJKKaWUUkoJpZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKKaWUUkoppZRSSimllFJKAQAmDw4AUAk2zrCSdFY4GlxoyEoAIDcAAFCKOcYklJBKSCWEEErlGITOSQkptVZCCq2ECjponaOQUkutlZRKSZmEEEIooYRSWikltVIyCKGEUEoIIaVSSgmhZVBCCiWUlFJJLbRUSskghFBaCamV1FoKJZWUQSmphJJSKq21lEpKrYPSUimttdZKSiGVllIHpaSWUimltRZKa621TlIpLaTWUmutlVZKKZ2llEpJrbWWWmsppVZCKa200lopJbXWUmstldRaS62l1lJrraXWSiklpZZaa621lloqKbWUQimllZJCaqml1koqLYTQUkmllVZaaymllEooJZWUWiqptZZSaKWF0kpJJaWWSioppdRSKqGUElIqoZXUUmuppZZKKi211FIrqZSWSkqpFAAAdOAAABBgRKWF2GnGlUfgiEKGCSgAABAEABiIkJlAoAAKDGQAwAFCghQAUFhgKF3oghAiSBdBFg9cOHHjiRtO6NAGABiIkJkAoRgiJGQDwARFhXQAsLjAKF3oghAiSBdBFg9cOHHjiRtO6NACAQAAAADAAQAfAAAHBhAR0VyGxgZHh8cHSIgIAAAAAAAAAAAAAACAT2dnUwAEESsAAAAAAAASWoVSAgAAAADmTLQXAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

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
    // Skip paths that resolve to a vanilla Core/DLC asset — writing a stub
    // here would shadow the base-game file at runtime (mods load after Core).
    if (req.vanilla) continue;
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
