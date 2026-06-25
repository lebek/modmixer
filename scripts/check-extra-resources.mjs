// Three checks against forge.config.ts + vite.main.config.ts to catch
// packaging bugs at PR review:
//
//  1. Every bare specifier marked `external` in vite.main.config.ts is also
//     shipped via `extraResource` in forge.config.ts. The combination
//     "external in vite + missing from extraResource" produces a packaged
//     main.js that does require('foo') at runtime against a stripped
//     node_modules — which throws "Cannot find module 'foo'" before
//     app.whenReady runs (no Sentry, no error dialog interception possible).
//     v0.4.4 hit this with web-tree-sitter.
//
//  2. Every staged-copy entry in extraResource (`dist/<name>`) actually
//     points to a directory in node_modules whose hoisted runtime deps are
//     either bundled by the staging function (nested under
//     dist/<name>/node_modules/<dep>) or shipped as a separate extraResource
//     entry. v0.6.0 hit this with `bindings` and `file-uri-to-path`: better-
//     sqlite3 was shipped via dist/, but its hoisted runtime deps were not,
//     so lib/database.js's require('bindings') threw on first index build.
//
//  3. Every non-staged extraResource entry actually exists on disk (plus key
//     fetched files inside placeholder dirs — see REQUIRED_FILES). Catches a
//     forgotten fetch/build step that would otherwise ship an installer with a
//     missing asset that only crashes at the feature's runtime — the Minecraft
//     bridge jar / NeoForge MDK / tree-sitter-java grammar each shipped missing
//     this way. Run in release.yml after the fetch steps so CI fails loudly.
//
// Run as part of `release.mjs` preflight AND in release.yml (after `npm ci` +
// the fetch steps) so a bad config or missing asset fails before a tag is cut.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const VITE_MAIN_CONFIG = path.join(repoRoot, 'vite.main.config.ts');
const FORGE_CONFIG = path.join(repoRoot, 'forge.config.ts');
const NODE_MODULES = path.join(repoRoot, 'node_modules');

// Externals that don't need to ship via extraResource: Electron is provided
// by the runtime; node: builtins are always present. Anything else that's
// marked external but not in extraResource is a bug.
const RUNTIME_PROVIDED = new Set(['electron']);

// Externals shipped inside the staged `dist/node_modules/` tree. That
// extraResource entry flattens to resources/node_modules/, so a bare
// require()/import() of the package from the packaged main.js resolves by
// directory walk-up out of the asar — no resourcesPath dual-resolve needed.
// Used for packages whose loader does a bare import we cannot intercept from
// our own code (e.g. @silvia-odwyer/photon-node, loaded deep inside
// @mariozechner/pi-coding-agent's read tool). Staged by stagePhotonNodeModules
// in forge.config.ts; satisfied here only when `dist/node_modules` is present
// in extraResource.
const STAGED_VIA_NODE_MODULES = new Set(['@silvia-odwyer/photon-node']);

// Per-staged-package deps that are listed in package.json#dependencies but
// are NOT required at runtime (build-time tools, prebuild fetchers, type-
// only deps, etc). Excluded from the deps-shipping check so they don't
// produce false positives. Add an entry here only after confirming the dep
// is unreferenced by the package's runtime code.
const NON_RUNTIME_DEPS = {
  // prebuild-install: build-time prebuild fetcher, never required at runtime.
  'better-sqlite3': new Set(['prebuild-install']),
  // @types/node: type-only declaration package, has no runtime entry point.
  'steamworks.js': new Set(['@types/node']),
};

// Committed placeholder dirs whose shipped CONTENTS are fetched at build time,
// so "the directory exists" is not enough — assert the specific files are
// present. resources/tree-sitter holds the tree-sitter grammars (C# fetched in
// postinstall, Java by `npm run fetch:tree-sitter-java`); without the Java wasm
// the Minecraft source index is dead in a packaged build, yet the dir itself
// (a committed .gitignore) would still look present. Keep this tight — only
// list files whose absence silently breaks a shipped feature.
const REQUIRED_FILES = {
  'resources/tree-sitter': ['tree-sitter-c-sharp.wasm', 'tree-sitter-java.wasm'],
  // inspect_mod is dead in a packaged build without the decompiler jar, yet the
  // committed dir (a .gitignore placeholder) would still look present.
  'resources/vineflower': ['vineflower.jar'],
};

/**
 * Strip JS/TS line and block comments. Necessary so that quoted strings
 * inside doc comments (e.g. `// see require('foo')`) don't get picked up
 * by the string-literal extractor below. Naive — assumes the configs
 * don't contain a string with the literal characters `//` or `/*`.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * Pull the contents of a top-level `name: [ ... ]` array out of TS source.
 * Both configs we care about have flat string-literal arrays — no nested
 * brackets, comments allowed, regex literals allowed (we filter those out).
 */
function extractArrayContents(src, name) {
  const needle = `${name}:`;
  let i = src.indexOf(needle);
  if (i < 0) return null;
  i = src.indexOf('[', i);
  if (i < 0) return null;
  let depth = 1;
  let end = i + 1;
  while (end < src.length && depth > 0) {
    const c = src[end];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    if (depth === 0) break;
    end++;
  }
  if (depth !== 0) return null;
  return src.slice(i + 1, end);
}

/** Pull single- or double-quoted string literals out of a chunk of source. */
function extractStringLiterals(chunk) {
  const out = [];
  const re = /(['"])((?:\\.|(?!\1).)*)\1/g;
  let m;
  while ((m = re.exec(chunk)) !== null) out.push(m[2]);
  return out;
}

function readExternals() {
  const src = stripComments(fs.readFileSync(VITE_MAIN_CONFIG, 'utf8'));
  const arr = extractArrayContents(src, 'external');
  if (arr == null) {
    throw new Error(`Could not find external: [...] in ${VITE_MAIN_CONFIG}`);
  }
  return extractStringLiterals(arr);
}

function readExtraResources() {
  const src = stripComments(fs.readFileSync(FORGE_CONFIG, 'utf8'));
  const arr = extractArrayContents(src, 'extraResource');
  if (arr == null) {
    throw new Error(`Could not find extraResource: [...] in ${FORGE_CONFIG}`);
  }
  return extractStringLiterals(arr);
}

/**
 * An extraResource entry "satisfies" an external if its trailing path
 * component matches the external's package specifier. Handles both:
 *   - 'node_modules/web-tree-sitter' satisfies 'web-tree-sitter'
 *   - 'node_modules/@vscode/ripgrep'  satisfies '@vscode/ripgrep'
 *   - 'dist/steamworks.js'            satisfies 'steamworks.js'  (staged copy)
 */
function satisfies(extraResource, external) {
  const norm = extraResource.replace(/\\/g, '/');
  return norm === external || norm.endsWith('/' + external);
}

/**
 * Pick out staged-copy entries: extraResource paths of the form `dist/<name>`
 * where `<name>` corresponds to a directory in node_modules. The staging
 * functions in forge.config.ts follow that convention. Skips generated
 * files like `dist/LICENSES.txt`.
 */
function stagedPackages(extraResources) {
  const out = [];
  for (const r of extraResources) {
    const norm = r.replace(/\\/g, '/');
    if (!norm.startsWith('dist/')) continue;
    const name = norm.slice('dist/'.length);
    if (name && fs.existsSync(path.join(NODE_MODULES, name))) {
      out.push(name);
    }
  }
  return out;
}

/**
 * Pull every string-literal that appears inside a `for (const X of [...])`
 * loop in forge.config.ts. The staging functions use that pattern to nest
 * hoisted deps under dist/<name>/node_modules/<dep>, so any name appearing
 * in such a loop is treated as "shipped via staging".
 *
 * Brittle but cheap. If the staging style changes, update this regex.
 */
function readStagedNestedDeps(forgeSrc) {
  const out = new Set();
  const re = /for\s*\(\s*const\s+\w+\s+of\s+\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(forgeSrc)) !== null) {
    for (const lit of extractStringLiterals(m[1])) out.add(lit);
  }
  return out;
}

/**
 * Direct prod deps of a package, as listed in node_modules/<name>/package.json.
 * Returns [] if the package isn't installed.
 */
function readPackageDeps(name) {
  const pkgPath = path.join(NODE_MODULES, name, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return Object.keys(pkg.dependencies ?? {});
}

/**
 * For each staged package in extraResource, walk its direct deps and verify
 * each one will be reachable in the packaged layout — either:
 *   (a) Not hoisted by npm (lives under node_modules/<name>/node_modules/<dep>,
 *       so it ships with the staged copy automatically).
 *   (b) Hoisted, and either nested by the staging function (string literal
 *       in a `for (const … of [...])` array in forge.config.ts) or shipped
 *       as a separate extraResource entry.
 *   (c) Not required at runtime (in NON_RUNTIME_DEPS allowlist).
 */
function checkStagedDeps(extraResources, forgeSrc) {
  const stagedNested = readStagedNestedDeps(forgeSrc);
  const missing = [];
  for (const pkg of stagedPackages(extraResources)) {
    const ignore = NON_RUNTIME_DEPS[pkg] ?? new Set();
    for (const dep of readPackageDeps(pkg)) {
      if (ignore.has(dep)) continue;
      const nestedInModule = fs.existsSync(
        path.join(NODE_MODULES, pkg, 'node_modules', dep),
      );
      if (nestedInModule) continue; // npm didn't hoist; ships with the staged copy
      const nestedByStaging = stagedNested.has(dep);
      const shippedDirectly = extraResources.some((r) => satisfies(r, dep));
      if (!nestedByStaging && !shippedDirectly) {
        missing.push({ pkg, dep });
      }
    }
  }
  return missing;
}

/**
 * Verify every extraResource entry actually exists on disk, so a forgotten
 * fetch/build step fails loudly here instead of silently shipping an installer
 * with a missing asset (which then crashes only at the feature's runtime — the
 * MC bridge jar / NeoForge MDK / tree-sitter-java grammar were each missing
 * from packaged builds this way). Entries under `dist/` are staged by the
 * generateAssets hooks during `electron-forge package`, so they don't exist
 * when this runs in preflight — skip them.
 */
function checkExtraResourcesExist(extraResources) {
  const missing = [];
  for (const entry of extraResources) {
    const norm = entry.replace(/\\/g, '/');
    if (norm.startsWith('dist/')) continue; // staged at package time
    const abs = path.join(repoRoot, norm);
    if (!fs.existsSync(abs)) {
      missing.push(norm);
      continue;
    }
    for (const file of REQUIRED_FILES[norm] ?? []) {
      if (!fs.existsSync(path.join(abs, file))) missing.push(`${norm}/${file}`);
    }
  }
  return missing;
}

function main() {
  const externals = readExternals().filter(
    (s) => !RUNTIME_PROVIDED.has(s) && !s.startsWith('node:'),
  );
  const extraResources = readExtraResources();
  const forgeSrc = stripComments(fs.readFileSync(FORGE_CONFIG, 'utf8'));

  const missingResources = checkExtraResourcesExist(extraResources);
  if (missingResources.length > 0) {
    console.error(
      'check-extra-resources: extraResource entries are missing on disk — a fetch/build step did not run:',
    );
    for (const m of missingResources) console.error(`  - ${m}`);
    console.error(
      '\nFix: run the matching fetch/build step before packaging, e.g.',
    );
    console.error('  npm run fetch:tree-sitter-java   # resources/tree-sitter/tree-sitter-java.wasm');
    console.error('  npm run fetch:neoforge-mdk       # vendor/neoforge-mdk');
    console.error('  npm run fetch:ilspycmd           # resources/ilspycmd/<platform>');
    console.error(
      'In CI these run after `npm ci` (release.yml); they are kept out of postinstall.',
    );
    process.exit(1);
  }

  const hasStagedNodeModules = extraResources.some(
    (r) => r.replace(/\\/g, '/') === 'dist/node_modules',
  );

  const missingExternals = externals.filter((e) => {
    if (extraResources.some((r) => satisfies(r, e))) return false;
    if (STAGED_VIA_NODE_MODULES.has(e) && hasStagedNodeModules) return false;
    return true;
  });

  if (missingExternals.length > 0) {
    console.error(
      'check-extra-resources: externals in vite.main.config.ts are missing from forge.config.ts extraResource:',
    );
    for (const m of missingExternals) console.error(`  - ${m}`);
    console.error(
      '\nFix: add `node_modules/<name>` (or a staged-copy path) to packagerConfig.extraResource,',
    );
    console.error(
      'and load the module via path.join(process.resourcesPath, <name>) in packaged builds',
    );
    console.error('(see src/agent/index/db.ts for the dual-resolve pattern).');
    process.exit(1);
  }

  const missingDeps = checkStagedDeps(extraResources, forgeSrc);
  if (missingDeps.length > 0) {
    console.error(
      'check-extra-resources: staged packages have hoisted runtime deps that are NOT shipped:',
    );
    for (const { pkg, dep } of missingDeps) {
      console.error(`  - dist/${pkg} requires ${dep} (hoisted to node_modules/${dep})`);
    }
    console.error(
      '\nFix: nest the dep under dist/<pkg>/node_modules/<dep> in the staging',
    );
    console.error(
      'function (forge.config.ts), add it as its own extraResource entry, or',
    );
    console.error(
      'add it to NON_RUNTIME_DEPS in this script if it is build-time only.',
    );
    process.exit(1);
  }

  console.log(
    `check-extra-resources: OK — ${externals.length} external${externals.length === 1 ? '' : 's'} all have shipping entries; ${extraResources.length} extraResource entries present on disk; staged-package deps verified.`,
  );
}

main();
