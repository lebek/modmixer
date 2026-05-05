import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

/**
 * Directory names skipped by every workspace/registry/asset scan.
 * Centralized so the three scanners can't drift.
 */
export const SKIP_DIRS = new Set([
  '.git',
  '.DS_Store',
  '.vs',
  'bin',
  'obj',
  'node_modules',
]);

/**
 * True iff a folder under RimWorld's Mods/ is a symlink resolving to the
 * given workspace path. On non-Windows we require lstat to report a symlink;
 * on Windows we allow junctions (which lstat reports as directories but
 * realpath still resolves through).
 */
export async function isSymlinkedInto(
  folder: string,
  workspacePath: string,
  rimworldModsDir: string,
): Promise<boolean> {
  const link = path.join(rimworldModsDir, folder);
  try {
    const st = await fsp.lstat(link);
    if (!st.isSymbolicLink() && process.platform !== 'win32') return false;
    const resolved = await fsp.realpath(link);
    return resolved === (await fsp.realpath(workspacePath));
  } catch {
    return false;
  }
}

export async function containsDll(dir: string): Promise<boolean> {
  if (!fs.existsSync(dir)) return false;
  try {
    const files = await fsp.readdir(dir);
    return files.some((f) => f.toLowerCase().endsWith('.dll'));
  } catch {
    return false;
  }
}

export async function readPublishedFileId(
  modPath: string,
): Promise<string | null> {
  const f = path.join(modPath, 'About', 'PublishedFileId.txt');
  try {
    const raw = (await fsp.readFile(f, 'utf8')).trim();
    return raw || null;
  } catch {
    return null;
  }
}
