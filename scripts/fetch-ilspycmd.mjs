// Build a self-contained ilspycmd for the current host platform and drop it
// into `resources/ilspycmd/<platform>-<arch>/`. Run this before `npm run make`
// in release CI on each OS so the matching binary ships with the installer.
//
// Requires the .NET SDK on the build machine (brew install --cask dotnet-sdk
// on macOS, the official installer on Windows). Fails with a clear message
// if the SDK isn't present.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ILSPY_REPO = 'https://github.com/icsharpcode/ILSpy.git';
// Pin to a known-good ILSpy tag. Bump deliberately — upstream's master
// occasionally breaks the standalone publish flow we rely on. To pick a
// new tag: visit https://github.com/icsharpcode/ILSpy/tags and grab the
// most recent one whose ICSharpCode.ILSpyCmd publishes cleanly with
// PublishSingleFile=true. Override at the command line via env if needed.
const ILSPY_TAG = process.env.ILSPY_TAG ?? 'v10.0.1';

const platform = process.platform;
const arch = process.arch;

const RID_BY_KEY = {
  'win32-x64': 'win-x64',
  'win32-arm64': 'win-arm64',
  'darwin-x64': 'osx-x64',
  'darwin-arm64': 'osx-arm64',
  'linux-x64': 'linux-x64',
};
const key = `${platform}-${arch}`;
const rid = RID_BY_KEY[key];
if (!rid) {
  console.error(`Unsupported host: ${key}`);
  process.exit(1);
}

const dotnet = spawnSync('dotnet', ['--version'], { encoding: 'utf8' });
if (dotnet.status !== 0) {
  console.error(
    'dotnet SDK not found. Install it before running this script:\n' +
      '  macOS:  brew install --cask dotnet-sdk\n' +
      '  Windows: https://dotnet.microsoft.com/download',
  );
  process.exit(1);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ilspycmd-build-'));
const repoDir = path.join(tmpRoot, 'ILSpy');

console.log(`Cloning ${ILSPY_REPO}@${ILSPY_TAG}...`);
execFileSync(
  'git',
  ['clone', '--depth', '1', '--branch', ILSPY_TAG, ILSPY_REPO, repoDir],
  { stdio: 'inherit' },
);

// ILSpy's global.json pins an exact older 8.0 patch that isn't pre-installed
// on current GitHub runner images. Drop it so dotnet falls back to whatever
// SDK is available locally — net8.0 projects build fine under newer SDKs.
const ilspyGlobalJson = path.join(repoDir, 'global.json');
if (fs.existsSync(ilspyGlobalJson)) fs.unlinkSync(ilspyGlobalJson);

console.log(`Publishing self-contained ilspycmd for ${rid}...`);
execFileSync(
  'dotnet',
  [
    'publish',
    'ICSharpCode.ILSpyCmd/ICSharpCode.ILSpyCmd.csproj',
    '-c',
    'Release',
    '-r',
    rid,
    '--self-contained',
    'true',
    '-p:PublishSingleFile=true',
    '-p:PublishTrimmed=false',
    // ILSpy ships packages.lock.json. Newer SDKs on the GH runner rewrite the
    // TFM and bump some referenced packages, which trips locked-mode restore.
    // We don't care about preserving the lock for an ephemeral build clone.
    '-p:RestoreLockedMode=false',
  ],
  { cwd: repoDir, stdio: 'inherit' },
);

// Find the produced binary. Path includes the TFM (e.g. net8.0).
const exe = platform === 'win32' ? 'ilspycmd.exe' : 'ilspycmd';
const publishGlob = path.join(
  repoDir,
  'ICSharpCode.ILSpyCmd/bin/Release',
);
const tfms = fs.readdirSync(publishGlob);
let produced = null;
for (const tfm of tfms) {
  const candidate = path.join(publishGlob, tfm, rid, 'publish', exe);
  if (fs.existsSync(candidate)) {
    produced = candidate;
    break;
  }
}
if (!produced) {
  console.error(`Could not find produced ilspycmd binary under ${publishGlob}`);
  process.exit(1);
}

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const destDir = path.join(repoRoot, 'resources/ilspycmd', key);
fs.mkdirSync(destDir, { recursive: true });
const dest = path.join(destDir, exe);
fs.copyFileSync(produced, dest);
if (platform !== 'win32') {
  fs.chmodSync(dest, 0o755);
}
console.log(`Wrote ${dest}`);
