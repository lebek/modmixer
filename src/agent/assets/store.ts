import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { getWorkspacePaths } from '../workspace.js';

function modRoot(folder: string): string {
  const { workspaceDir } = getWorkspacePaths();
  const abs = path.join(workspaceDir, folder);
  if (!fs.existsSync(abs)) {
    throw new Error(`Workspace mod not found: ${folder}`);
  }
  return abs;
}

/** Resolve a relative path under the mod root, refusing anything that escapes it. */
function safeJoin(modDir: string, relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(modDir, ...normalized.split('/'));
  const rootResolved = path.resolve(modDir);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw new Error(`Path escapes mod folder: ${relPath}`);
  }
  return abs;
}

export async function addAssetFile(
  folder: string,
  destRelPath: string,
  sourceAbsPath: string,
): Promise<void> {
  const modDir = modRoot(folder);
  const dest = safeJoin(modDir, destRelPath);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(sourceAbsPath, dest);
}

export async function removeAssetFile(folder: string, relPath: string): Promise<void> {
  const modDir = modRoot(folder);
  const target = safeJoin(modDir, relPath);
  try {
    await fsp.unlink(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
}

export async function readAssetDataUrl(
  folder: string,
  relPath: string,
): Promise<string | null> {
  const modDir = modRoot(folder);
  const abs = safeJoin(modDir, relPath);
  let buf: Buffer;
  try {
    buf = await fsp.readFile(abs);
  } catch {
    return null;
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.ogg' ? 'audio/ogg' : 'application/octet-stream';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

export function modAbsPath(folder: string): string {
  return modRoot(folder);
}
