// Download a prebuilt `tree-sitter-java.wasm` and place it at
// `resources/tree-sitter/tree-sitter-java.wasm`. Mirrors the C# variant — the
// Minecraft (NeoForge) source index extracts Java symbols from the decompiled
// Minecraft + NeoForge sources using this grammar.
//
// Run once at install time (and again when the pinned tag is bumped). If you'd
// rather build from source: `npx tree-sitter build -w`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = 'v0.23.5';
const URL = `https://github.com/tree-sitter/tree-sitter-java/releases/download/${TAG}/tree-sitter-java.wasm`;

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const destDir = path.join(root, 'resources/tree-sitter');
fs.mkdirSync(destDir, { recursive: true });
const dest = path.join(destDir, 'tree-sitter-java.wasm');

console.log(`Fetching ${URL}...`);
const res = await fetch(URL);
if (!res.ok) {
  console.error(`Fetch failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
fs.writeFileSync(dest, buf);
console.log(`Wrote ${dest} (${buf.length} bytes)`);
