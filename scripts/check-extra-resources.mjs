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
// Run as part of `release.mjs` preflight so a bad config fails before a tag
// is cut.

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

function main() {
  const externals = readExternals().filter(
    (s) => !RUNTIME_PROVIDED.has(s) && !s.startsWith('node:'),
  );
  const extraResources = readExtraResources();
  const forgeSrc = stripComments(fs.readFileSync(FORGE_CONFIG, 'utf8'));

  const missingExternals = externals.filter(
    (e) => !extraResources.some((r) => satisfies(r, e)),
  );

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
    `check-extra-resources: OK — ${externals.length} external${externals.length === 1 ? '' : 's'} all have shipping entries; staged-package deps verified.`,
  );
}

main();
