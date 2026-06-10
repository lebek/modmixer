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
  // Modmixer sidecar dir living at the workspace root. Holds per-mod data
  // we explicitly don't want shipped to Steam (e.g. preview BG sources)
  // and which RimWorld must never see as a candidate mod folder.
  '.modmixer',
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

/**
 * True iff a readdir Dirent names a scannable directory — a real directory,
 * or a symlink/junction resolving to one. Junctions are how Modmixer syncs
 * workspace mods into RimWorld's Mods/ and installs the bridge/live infra
 * mods, and Dirent reports them as symlinks, NOT directories — a plain
 * isDirectory() check silently hides every one of them. RimWorld itself
 * follows junctions, so scanners must too.
 */
export async function direntIsDirectoryLike(
  entry: fs.Dirent,
  parentDir: string,
): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await fsp.stat(path.join(parentDir, entry.name))).isDirectory();
  } catch {
    return false; // dangling link
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

/**
 * Most-recent mtime of any file or directory under `dir`, recursively, in epoch
 * ms. Skips SKIP_DIRS. Folder mtime alone misses in-place file edits, and file
 * mtimes alone miss adds/renames/deletes — taking the max of both catches every
 * meaningful change. Returns 0 on missing/unreadable input.
 */
export async function latestMtimeMs(dir: string): Promise<number> {
  let latest = 0;
  const stack: string[] = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      const st = await fsp.stat(cur);
      if (st.mtimeMs > latest) latest = st.mtimeMs;
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    const fileMtimes = await Promise.all(
      entries
        .filter((e) => !SKIP_DIRS.has(e.name))
        .map(async (e) => {
          const full = path.join(cur, e.name);
          if (e.isDirectory()) {
            stack.push(full);
            return 0;
          }
          try {
            const st = await fsp.stat(full);
            return st.mtimeMs;
          } catch {
            return 0;
          }
        }),
    );
    for (const m of fileMtimes) {
      if (m > latest) latest = m;
    }
  }
  return latest;
}
