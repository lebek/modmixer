import fs from 'node:fs';
import path from 'node:path';
import { detectRimWorldPaths } from '../paths.js';
import { getIndexPaths } from './paths.js';

/** Bump when the schema or tool contract changes so existing indexes get nuked. */
export const INDEX_SCHEMA_VERSION = 2;

export interface IndexMeta {
  schemaVersion: number;
  /** RimWorld Version.txt content at index build time, e.g. "1.6.4633 rev1266". */
  rimworldVersion: string;
  /** Sorted list of DLC pack names that were indexed (Royalty/Ideology/Biotech/Anomaly). */
  dlcs: string[];
  /** Set of <packageId>@<mtime> for enabled-mod defs included in the index. */
  modFingerprints: string[];
  builtAt: string;
  /** Counts for the settings UI. */
  defCount: number;
  symbolCount: number;
  /** Sum of bytes under $root/Source/. Approximate; for the settings UI. */
  sourceBytes: number;
}

export interface IndexFingerprint {
  rimworldVersion: string;
  dlcs: string[];
  modFingerprints: string[];
  schemaVersion: number;
}

export function readMeta(): IndexMeta | null {
  const { metaPath } = getIndexPaths();
  if (!fs.existsSync(metaPath)) return null;
  try {
    const raw = fs.readFileSync(metaPath, 'utf8');
    const obj = JSON.parse(raw) as IndexMeta;
    if (typeof obj.schemaVersion !== 'number') return null;
    return obj;
  } catch {
    return null;
  }
}

export function writeMeta(meta: IndexMeta): void {
  const { metaPath } = getIndexPaths();
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

/**
 * Snapshot the current install + selected mod set. Caller compares against
 * meta.json to decide whether to rebuild. modFingerprints is empty unless
 * the caller has computed it (cheap walk over the user's enabled mods).
 */
export function detectFingerprint(modFingerprints: string[] = []): IndexFingerprint | null {
  const rim = detectRimWorldPaths();
  if (!rim.managedDir || !rim.dataDir) return null;
  const dataDir = rim.dataDir;
  // Version.txt sits near the install root. On Windows/Linux dataDir is
  // <install>/Data, so Version.txt is one level up. On macOS dataDir is
  // <bundle>/Contents/Resources, and Version.txt lives at <bundle>/Version.txt
  // (two levels up). Probe both.
  const installRoot = path.dirname(dataDir);
  const versionCandidates = [
    path.join(installRoot, 'Version.txt'),
    path.join(installRoot, '..', 'Version.txt'),
  ];
  let rimworldVersion = 'unknown';
  for (const c of versionCandidates) {
    if (fs.existsSync(c)) {
      try {
        rimworldVersion = fs.readFileSync(c, 'utf8').trim();
        break;
      } catch {
        // try next
      }
    }
  }

  // Detect DLC packs by looking at <Data>/<Pack>/ directories. Standard set:
  // Core, Royalty, Ideology, Biotech, Anomaly, Odyssey. Any pack folder with
  // a Defs/ subdir is considered "owned by the user" for indexing purposes.
  const dlcs: string[] = [];
  if (fs.existsSync(dataDir)) {
    for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const defsSubdir = path.join(dataDir, entry.name, 'Defs');
      if (fs.existsSync(defsSubdir)) dlcs.push(entry.name);
    }
    dlcs.sort();
  }

  return {
    rimworldVersion,
    dlcs,
    modFingerprints: [...modFingerprints].sort(),
    schemaVersion: INDEX_SCHEMA_VERSION,
  };
}

export function fingerprintMatches(meta: IndexMeta, fp: IndexFingerprint): boolean {
  if (meta.schemaVersion !== fp.schemaVersion) return false;
  if (meta.rimworldVersion !== fp.rimworldVersion) return false;
  if (meta.dlcs.length !== fp.dlcs.length) return false;
  for (let i = 0; i < meta.dlcs.length; i++) {
    if (meta.dlcs[i] !== fp.dlcs[i]) return false;
  }
  if (meta.modFingerprints.length !== fp.modFingerprints.length) return false;
  for (let i = 0; i < meta.modFingerprints.length; i++) {
    if (meta.modFingerprints[i] !== fp.modFingerprints[i]) return false;
  }
  return true;
}
