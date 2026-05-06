#!/usr/bin/env node
// Wrapper for `electron-forge start` that pins npm_config_arch to whatever
// arch the installed Electron binary actually is. Needed because:
//   1. On Windows-on-ARM the host runs arm64, but Electron itself ships as
//      x64 (no win-arm64 dist of steamworks.js) and runs under Prism. A
//      rebuild targeting host arch produces an arm64 .node that the x64
//      Electron process refuses to load with "not a valid Win32 application".
//   2. Forge's start path reads `process.env.npm_config_arch || process.arch`
//      to choose the rebuild arch (see @electron-forge/core start.js).
//   3. The historical fix — pinning `arch=x64` in .npmrc — stopped working
//      in npm 11+, which now logs "Unknown project config 'arch'" and skips
//      translating that key into the npm_config_arch env var.
// So we probe the Electron PE machine type ourselves and inject the env var.

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function detectElectronArch() {
  if (process.platform !== 'win32') return process.arch;
  const exe = path.join(repoRoot, 'node_modules/electron/dist/electron.exe');
  if (!fs.existsSync(exe)) return process.arch;
  const fd = fs.openSync(exe, 'r');
  try {
    const buf = Buffer.alloc(1024);
    fs.readSync(fd, buf, 0, 1024, 0);
    const peOff = buf.readInt32LE(0x3c);
    const machine = buf.readUInt16LE(peOff + 4);
    if (machine === 0x8664) return 'x64';
    if (machine === 0xaa64) return 'arm64';
  } finally {
    fs.closeSync(fd);
  }
  return process.arch;
}

const arch = detectElectronArch();
const env = { ...process.env, npm_config_arch: arch };

if (arch !== process.arch) {
  console.log(
    `[dev-start] host=${process.arch}, electron=${arch} — pinning npm_config_arch=${arch}`,
  );
}

// Resolve the package's main entry instead of running the .cmd shim. Node
// 20+ refuses to spawn .cmd/.bat without `shell: true` (CVE-2024-27980),
// and shell mode brings its own quoting hazards. Running the JS entry
// directly via `process.execPath` sidesteps both issues and works the same
// on every OS.
const cliJs = path.join(
  repoRoot,
  'node_modules/@electron-forge/cli/dist/electron-forge.js',
);
const child = spawn(
  process.execPath,
  [cliJs, 'start', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env,
    shell: false,
  },
);
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
