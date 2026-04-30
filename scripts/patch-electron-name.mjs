// Renames the dev Electron bundle to Modmixer so the dock tooltip and menu
// bar match the packaged app. macOS on modern releases derives the displayed
// app name from a mix of CFBundleName, CFBundleDisplayName, the .app
// directory's basename, and the executable's filename — patching only the
// plist isn't enough on Tahoe+. We rename:
//   Electron.app → Modmixer.app
//   Electron.app/Contents/MacOS/Electron → Modmixer.app/Contents/MacOS/Modmixer
// and rewrite node_modules/electron/path.txt so the npm `electron` shim
// still finds the binary.
//
// Re-runs on every npm install (the install resets node_modules/electron).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);

const here = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.resolve(here, '..', 'node_modules/electron');
const distDir = path.join(electronDir, 'dist');
const NAME = 'Modmixer';

if (!existsSync(distDir)) process.exit(0);

const oldApp = path.join(distDir, 'Electron.app');
const newApp = path.join(distDir, `${NAME}.app`);

if (existsSync(oldApp) && !existsSync(newApp)) {
  renameSync(oldApp, newApp);
}

const oldBin = path.join(newApp, 'Contents/MacOS/Electron');
const newBin = path.join(newApp, `Contents/MacOS/${NAME}`);
if (existsSync(oldBin) && !existsSync(newBin)) {
  renameSync(oldBin, newBin);
}

const plist = path.join(newApp, 'Contents/Info.plist');
if (existsSync(plist)) {
  const set = (key, value) => {
    try {
      execFileSync('/usr/libexec/PlistBuddy', [
        '-c',
        `Set :${key} ${value}`,
        plist,
      ]);
    } catch {
      execFileSync('/usr/libexec/PlistBuddy', [
        '-c',
        `Add :${key} string ${value}`,
        plist,
      ]);
    }
  };
  set('CFBundleName', NAME);
  set('CFBundleDisplayName', NAME);
  set('CFBundleExecutable', NAME);
}

// The npm `electron` shim reads path.txt to spawn the binary. Point it at
// the renamed bundle.
const pathTxt = path.join(electronDir, 'path.txt');
if (existsSync(pathTxt)) {
  const want = `${NAME}.app/Contents/MacOS/${NAME}`;
  const cur = readFileSync(pathTxt, 'utf8').trim();
  if (cur !== want) writeFileSync(pathTxt, want);
}

console.log(`[patch-electron-name] bundle renamed to ${NAME}.app`);
