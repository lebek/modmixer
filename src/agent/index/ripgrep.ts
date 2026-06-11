import path from 'node:path';

let cachedRgPath: string | null | undefined;

/**
 * Locate the ripgrep binary. Prefers the regular module require (works in
 * dev). Falls back to the resourcesPath copy that Forge ships in packaged
 * builds. Returns null when neither resolves.
 */
export function resolveRipgrep(): string | null {
  if (cachedRgPath !== undefined) return cachedRgPath;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@vscode/ripgrep') as { rgPath: string };
    cachedRgPath = mod.rgPath;
    return cachedRgPath;
  } catch {
    // try packaged path next
  }
  try {
    const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
    cachedRgPath = path.join(
      process.resourcesPath,
      'ripgrep',
      'bin',
      exe,
    );
  } catch {
    cachedRgPath = null;
  }
  return cachedRgPath;
}
