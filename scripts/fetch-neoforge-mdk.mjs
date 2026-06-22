#!/usr/bin/env node
// Vendor the official NeoForge ModDevGradle 1.21.1 MDK as a project template.
// ModMixer scaffolds Minecraft mods by copying vendor/neoforge-mdk/template/
// and stamping gradle.properties (see src/agent/minecraft/scaffold.ts).
//
// This is a build-time step (not in postinstall, so RimWorld-only installs
// aren't forced to download it). Run: npm run fetch:neoforge-mdk
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'NeoForgeMDKs/MDK-1.21.1-ModDevGradle';
const REF = 'main';
const ZIP_URL = `https://codeload.github.com/${REPO}/zip/refs/heads/${REF}`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'vendor', 'neoforge-mdk');
const templateDir = path.join(vendorDir, 'template');

async function extractZip(zipPath, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${destDir}'`],
      { stdio: 'inherit' },
    );
  } else {
    // bsdtar (macOS) and GNU unzip both handle this; prefer unzip for portability.
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { stdio: 'inherit' });
  }
}

async function main() {
  if (fs.existsSync(path.join(templateDir, 'gradle.properties'))) {
    console.log('[fetch:neoforge-mdk] template already present, skipping.');
    return;
  }
  console.log(`[fetch:neoforge-mdk] downloading ${ZIP_URL}`);
  const res = await fetch(ZIP_URL);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'neoforge-mdk-'));
  const zipPath = path.join(tmp, 'mdk.zip');
  await fsp.writeFile(zipPath, Buffer.from(await res.arrayBuffer()));

  await extractZip(zipPath, tmp);
  // GitHub zips extract to <repo>-<ref>/.
  const extractedRoot = path.join(tmp, `MDK-1.21.1-ModDevGradle-${REF}`);
  if (!fs.existsSync(path.join(extractedRoot, 'gradle.properties'))) {
    throw new Error(`unexpected MDK layout at ${extractedRoot}`);
  }

  await fsp.rm(templateDir, { recursive: true, force: true });
  await fsp.mkdir(vendorDir, { recursive: true });
  await fsp.cp(extractedRoot, templateDir, { recursive: true });
  // Drop files we don't want in a scaffolded mod (CI, license-of-the-MDK, git).
  for (const junk of ['.github', '.git', 'LICENSE.txt', 'changelog.md']) {
    await fsp.rm(path.join(templateDir, junk), { recursive: true, force: true });
  }
  await fsp.rm(tmp, { recursive: true, force: true });
  console.log(`[fetch:neoforge-mdk] vendored MDK -> ${templateDir}`);
}

main().catch((err) => {
  console.error('[fetch:neoforge-mdk] failed:', err.message);
  process.exit(1);
});
