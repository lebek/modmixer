// Download a prebuilt `tree-sitter-c-sharp.wasm` and place it at
// `resources/tree-sitter/tree-sitter-c-sharp.wasm`. Run once at install time
// (and again whenever the pinned version is bumped). The wasm is loaded by
// the index engine to extract C# symbols.
//
// We pull from the tree-sitter-grammars/tree-sitter-c-sharp release assets,
// which publish a stable prebuilt wasm per tag. If you'd rather build from
// source: `npx tree-sitter build -w`. Bumping the tag below picks up grammar
// updates.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = 'v0.23.1';
const URL = `https://github.com/tree-sitter/tree-sitter-c-sharp/releases/download/${TAG}/tree-sitter-c_sharp.wasm`;

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const destDir = path.join(root, 'resources/tree-sitter');
fs.mkdirSync(destDir, { recursive: true });
const dest = path.join(destDir, 'tree-sitter-c-sharp.wasm');

console.log(`Fetching ${URL}...`);
const res = await fetch(URL);
if (!res.ok) {
  console.error(`Fetch failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
fs.writeFileSync(dest, buf);
console.log(`Wrote ${dest} (${buf.length} bytes)`);
