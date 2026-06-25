// Download the Vineflower decompiler jar to `resources/vineflower/vineflower.jar`.
// Vineflower is the standalone Java decompiler the inspect_mod tool runs to turn
// an installed NeoForge mod's compiled .class files into readable Java. NeoForge
// 1.21.1 mods ship compiled against mojmap at runtime, so a plain Vineflower pass
// yields source referencing net.minecraft.*/net.neoforged.* by readable names —
// no remapping needed. Platform-independent (a runnable fat jar), so unlike
// ilspycmd there's no per-arch subdir.
//
// Idempotent: skips the download when a non-trivial jar is already present, so it
// can run in postinstall without re-fetching on every `npm install`. Bump
// VINEFLOWER_VERSION deliberately; override via env for a one-off.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = process.env.VINEFLOWER_VERSION ?? '1.11.1';
const URL =
  process.env.VINEFLOWER_URL ??
  `https://repo1.maven.org/maven2/org/vineflower/vineflower/${VERSION}/vineflower-${VERSION}.jar`;

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const destDir = path.join(root, 'resources/vineflower');
const dest = path.join(destDir, 'vineflower.jar');

// Skip if already fetched (size guard catches truncated/partial downloads).
if (fs.existsSync(dest) && fs.statSync(dest).size > 100 * 1024) {
  console.log(`Vineflower already present at ${dest}; skipping.`);
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });
console.log(`Fetching ${URL}...`);
const res = await fetch(URL);
if (!res.ok) {
  console.error(`Fetch failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
fs.writeFileSync(dest, buf);
console.log(`Wrote ${dest} (${buf.length} bytes)`);
