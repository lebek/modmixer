// Atomic ModsConfig.xml reader/writer. All registry writes route here so
// backups, locks, and the "RimWorld must be closed" guard are enforced in
// exactly one place. Direct fs writes elsewhere are a bug.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { isRimWorldRunning } from '../game.js';
import { detectRimWorldPaths } from '../paths.js';

export interface ModsConfigContents {
  /** Game version string from <version>, e.g. "1.6.123 rev123". May be empty. */
  version: string;
  /** Active mods in load order, lowercased packageIds. */
  activeMods: string[];
  /** Known DLCs/expansions list, lowercased packageIds. */
  knownExpansions: string[];
}

const EMPTY: ModsConfigContents = {
  version: '',
  activeMods: [],
  knownExpansions: [],
};

const BACKUPS_DIR = '.modmixer-backups';
const MAX_BACKUPS = 20;

/**
 * Read ModsConfig.xml. Returns an empty record if the file doesn't exist
 * (e.g. first launch before RimWorld has ever run).
 */
export async function readModsConfig(): Promise<ModsConfigContents> {
  const file = detectRimWorldPaths().modsConfig;
  if (!file) return { ...EMPTY };
  try {
    const xml = await fsp.readFile(file, 'utf8');
    return parseModsConfig(xml);
  } catch {
    return { ...EMPTY };
  }
}

export function parseModsConfig(rawXml: string): ModsConfigContents {
  const xml = (rawXml ?? '').replace(/^\uFEFF/, '');
  const version = matchScalar(xml, 'version');
  const activeMods = matchList(xml, 'activeMods').map((s) => s.toLowerCase());
  const knownExpansions = matchList(xml, 'knownExpansions').map((s) =>
    s.toLowerCase(),
  );
  return { version, activeMods, knownExpansions };
}

/**
 * Replace the active mod list and load order. Preserves <version> and
 * <knownExpansions> from the existing file. Refuses to write while RimWorld is
 * running because the game rewrites ModsConfig.xml on quit and would
 * overwrite our edits.
 */
export async function writeActiveMods(activeMods: string[]): Promise<void> {
  const file = detectRimWorldPaths().modsConfig;
  if (!file) {
    throw new Error(
      'ModsConfig.xml not found. Launch RimWorld at least once first so it can create the file.',
    );
  }
  if (await isRimWorldRunning()) {
    throw new Error(
      "RimWorld is currently running. Edits to ModsConfig.xml are overwritten when the game quits, and a running game won't pick up new mods. Quit RimWorld first, then retry.",
    );
  }

  const existing = fs.existsSync(file) ? await fsp.readFile(file, 'utf8') : '';
  await ensureBackup(file, existing);

  const parsed = existing ? parseModsConfig(existing) : { ...EMPTY };
  const next = renderModsConfigXml({
    version: parsed.version,
    activeMods: dedupePreserveOrder(activeMods.map((s) => s.toLowerCase())),
    knownExpansions: parsed.knownExpansions,
  });

  await atomicWrite(file, next);
}

/**
 * Restore ModsConfig.xml directly from a snapshot string. Used by the
 * snapshot-restore session primitive — we don't re-render, we put the user's
 * exact previous bytes back.
 */
export async function restoreFromSnapshot(snapshot: string): Promise<void> {
  const file = detectRimWorldPaths().modsConfig;
  if (!file) {
    throw new Error('ModsConfig.xml path could not be resolved.');
  }
  if (await isRimWorldRunning()) {
    throw new Error(
      'RimWorld is running — quit it first so the restore is not overwritten.',
    );
  }
  await atomicWrite(file, snapshot);
}

/** Read a raw snapshot of the file for session bookkeeping. */
export async function snapshotModsConfig(): Promise<string | null> {
  const file = detectRimWorldPaths().modsConfig;
  if (!file || !fs.existsSync(file)) return null;
  return fsp.readFile(file, 'utf8');
}

export function renderModsConfigXml(c: ModsConfigContents): string {
  const active = c.activeMods.map((p) => `    <li>${escapeXml(p)}</li>`).join('\n');
  const known = c.knownExpansions
    .map((p) => `    <li>${escapeXml(p)}</li>`)
    .join('\n');
  // Mirror RimWorld's own writer: <?xml version="1.0" encoding="utf-8"?>
  // followed by <ModsConfigData> with version, activeMods, knownExpansions.
  return `<?xml version="1.0" encoding="utf-8"?>
<ModsConfigData>
  <version>${escapeXml(c.version)}</version>
  <activeMods>
${active}
  </activeMods>
  <knownExpansions>
${known}
  </knownExpansions>
</ModsConfigData>
`;
}

async function ensureBackup(file: string, contents: string): Promise<void> {
  if (!contents) return;
  const dir = path.join(path.dirname(file), BACKUPS_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = path.join(dir, `ModsConfig.${stamp}.xml`);
  await fsp.writeFile(dst, contents, 'utf8');
  await pruneOldBackups(dir);
}

async function pruneOldBackups(dir: string): Promise<void> {
  try {
    const entries = await fsp.readdir(dir);
    const backups = entries
      .filter((f) => f.startsWith('ModsConfig.') && f.endsWith('.xml'))
      .sort();
    if (backups.length <= MAX_BACKUPS) return;
    const overflow = backups.slice(0, backups.length - MAX_BACKUPS);
    for (const f of overflow) {
      try {
        await fsp.unlink(path.join(dir, f));
      } catch {
        // ignore — best-effort cleanup
      }
    }
  } catch {
    // ignore — backup pruning is best-effort
  }
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  const tmp = `${file}.modmixer-tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, contents, 'utf8');
  await fsp.rename(tmp, file);
}

export async function listBackups(): Promise<{ file: string; stamp: string }[]> {
  const cfg = detectRimWorldPaths().modsConfig;
  if (!cfg) return [];
  const dir = path.join(path.dirname(cfg), BACKUPS_DIR);
  try {
    const entries = await fsp.readdir(dir);
    return entries
      .filter((f) => f.startsWith('ModsConfig.') && f.endsWith('.xml'))
      .sort()
      .reverse()
      .map((f) => {
        const stamp = f.replace(/^ModsConfig\.|\.xml$/g, '');
        return { file: path.join(dir, f), stamp };
      });
  } catch {
    return [];
  }
}

function dedupePreserveOrder(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function matchScalar(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = xml.match(re);
  return (m?.[1] ?? '').trim();
}

function matchList(xml: string, parent: string): string[] {
  const re = new RegExp(`<${parent}\\b[^>]*>([\\s\\S]*?)</${parent}>`, 'i');
  const m = xml.match(re);
  if (!m) return [];
  const stripped = m[1].replace(/<!--[\s\S]*?-->/g, '');
  const items: string[] = [];
  const inner = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let mm: RegExpExecArray | null;
  while ((mm = inner.exec(stripped)) !== null) {
    const v = mm[1].trim();
    if (v) items.push(v);
  }
  return items;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
