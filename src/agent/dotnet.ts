// Locate the `dotnet` executable on the user's machine.
//
// Electron apps on Windows (and to a lesser extent on macOS launched from
// Finder) don't always inherit the same PATH a shell would — most notoriously,
// the dotnet installer adds `C:\Program Files\dotnet\` to PATH, but Electron
// instances launched from the Start menu before the user logs back in may not
// see it. So we resolve dotnet to an absolute path: walk PATH first (covers
// shell-launched runs and CI), fall back to standard install locations,
// return null if nothing matches.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveDotnet(): string | null {
  const exe = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
  const home = os.homedir();
  const candidates: string[] = [];

  // 1. PATH — fast path when Electron inherited a sane env.
  const pathEnv = process.env.PATH ?? '';
  for (const entry of pathEnv.split(path.delimiter)) {
    if (!entry) continue;
    const expanded = entry.startsWith('~')
      ? path.join(home, entry.slice(1))
      : entry;
    candidates.push(path.join(expanded, exe));
  }

  // 2. DOTNET_ROOT if the user set one explicitly (CI, custom installs).
  if (process.env.DOTNET_ROOT) {
    candidates.push(path.join(process.env.DOTNET_ROOT, exe));
  }

  // 3. Standard install locations per platform.
  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\dotnet\\dotnet.exe',
      'C:\\Program Files (x86)\\dotnet\\dotnet.exe',
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/usr/local/share/dotnet/dotnet',
      '/opt/homebrew/share/dotnet/dotnet',
      '/usr/local/bin/dotnet',
    );
  } else {
    candidates.push(
      '/usr/share/dotnet/dotnet',
      '/usr/bin/dotnet',
      '/snap/bin/dotnet',
      path.join(home, '.dotnet', 'dotnet'),
    );
  }

  for (const c of candidates) {
    try {
      const mode =
        process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
      fs.accessSync(c, mode);
      return c;
    } catch {
      // next
    }
  }
  return null;
}

export const DOTNET_NOT_FOUND_MESSAGE =
  'dotnet not found. Install the .NET SDK from https://dotnet.microsoft.com/download (any 6.0+ release works) and restart Modmixer. ' +
  'On Windows the installer adds dotnet to PATH, but Electron only picks up a new PATH after you fully relaunch — closing the app and reopening from the Start menu is enough.';
