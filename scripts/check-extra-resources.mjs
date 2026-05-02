// Verify every bare-specifier marked external in vite.main.config.ts is also
// shipped via extraResource in forge.config.ts. The combination "external in
// vite + missing from extraResource" produces a packaged main.js that does
// require('foo') at runtime against a stripped node_modules — which throws
// "Cannot find module 'foo'" before app.whenReady runs (no Sentry, no error
// dialog interception possible). v0.4.4 hit this with web-tree-sitter.
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

// Externals that don't need to ship via extraResource: Electron is provided
// by the runtime; node: builtins are always present. Anything else that's
// marked external but not in extraResource is a bug.
const RUNTIME_PROVIDED = new Set(['electron']);

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

function main() {
  const externals = readExternals().filter(
    (s) => !RUNTIME_PROVIDED.has(s) && !s.startsWith('node:'),
  );
  const extraResources = readExtraResources();

  const missing = externals.filter(
    (e) => !extraResources.some((r) => satisfies(r, e)),
  );

  if (missing.length > 0) {
    console.error(
      'check-extra-resources: externals in vite.main.config.ts are missing from forge.config.ts extraResource:',
    );
    for (const m of missing) console.error(`  - ${m}`);
    console.error(
      '\nFix: add `node_modules/<name>` (or a staged-copy path) to packagerConfig.extraResource,',
    );
    console.error(
      'and load the module via path.join(process.resourcesPath, <name>) in packaged builds',
    );
    console.error('(see src/agent/index/db.ts for the dual-resolve pattern).');
    process.exit(1);
  }

  console.log(
    `check-extra-resources: OK — ${externals.length} external${externals.length === 1 ? '' : 's'} all have shipping entries.`,
  );
}

main();
