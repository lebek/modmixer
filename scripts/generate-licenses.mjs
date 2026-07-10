// Generates dist/LICENSES.txt — third-party license attributions for the
// runtime JS deps that get bundled into the packaged app. Forge already
// ships Electron's LICENSE and LICENSES.chromium.html at the package root;
// this file covers everything Vite rolls up from package.json#dependencies.
//
// The pi packages (@earendil-works/*) don't ship a LICENSE file in their
// npm tarballs, so we embed the upstream MIT text inline.
//
// Wired in as a Forge generateAssets hook, and the output is included via
// extraResource so it lands at Contents/Resources/LICENSES.txt on macOS and
// resources/LICENSES.txt on Windows/Linux.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const pkg = JSON.parse(
  readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);

const PI_MONO_LICENSE = `MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

// @resvg/resvg-wasm doesn't ship a LICENSE file; its README points at the
// standard MPL 2.0 text. The canonical text is checked in at
// scripts/licenses/MPL-2.0.txt (copied from the lightningcss dep, which
// also ships under MPL-2.0).
const MPL_2_0_LICENSE = readFileSync(
  path.join(here, 'licenses', 'MPL-2.0.txt'),
  'utf8',
);

const LICENSE_OVERRIDES = {
  '@earendil-works/pi-agent-core': PI_MONO_LICENSE,
  '@earendil-works/pi-ai': PI_MONO_LICENSE,
  '@earendil-works/pi-coding-agent': PI_MONO_LICENSE,
  '@resvg/resvg-wasm': MPL_2_0_LICENSE,
};

const LICENSE_FILENAMES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'license',
  'license.md',
  'license.txt',
];

function findLicenseText(name) {
  if (LICENSE_OVERRIDES[name]) return LICENSE_OVERRIDES[name];
  const dir = path.join(repoRoot, 'node_modules', name);
  for (const fn of LICENSE_FILENAMES) {
    const p = path.join(dir, fn);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return null;
}

function readPackageMeta(name) {
  const p = path.join(repoRoot, 'node_modules', name, 'package.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

const deps = Object.keys(pkg.dependencies ?? {}).sort();
const missing = [];
const sections = [];

for (const name of deps) {
  const meta = readPackageMeta(name);
  const license = meta.license ?? meta.licenses?.[0]?.type ?? 'UNKNOWN';
  const version = meta.version ?? '?';
  const text = findLicenseText(name);
  if (!text) {
    missing.push(name);
    continue;
  }
  sections.push(
    `${'='.repeat(78)}\n${name}@${version} — ${license}\n${'='.repeat(78)}\n\n${text.trimEnd()}\n`,
  );
}

if (missing.length > 0) {
  console.error(
    `[generate-licenses] missing license text for: ${missing.join(', ')}`,
  );
  process.exit(1);
}

const header = `Modmixer ${pkg.version} — Third-Party Notices

This file collects the licenses of third-party JavaScript packages that are
bundled into the Modmixer application. Electron's own license and the
Chromium third-party notices are shipped separately as LICENSE and
LICENSES.chromium.html at the root of the distribution.
`;

const out = `${header}\n${sections.join('\n')}`;

const distDir = path.join(repoRoot, 'dist');
if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });
const outPath = path.join(distDir, 'LICENSES.txt');
writeFileSync(outPath, out);
console.log(
  `[generate-licenses] wrote ${outPath} (${deps.length} packages, ${out.length} bytes)`,
);
