#!/usr/bin/env node
/**
 * Runner for the headless A/B turn-replay harness.
 *
 *   node scripts/harness/run.mjs --title "thunderstorm" --until "make it sunny" \
 *        --model moonshotai/kimi-k2.6 --provider openrouter --repeat 3 [--dry]
 *
 * Steps: resolve the target chat from conversations.json → esbuild-bundle
 * replay.ts into a self-contained Electron-main CJS file (natives external)
 * → launch the project's Electron binary on it (arch pinned like dev-start)
 * → relay output. The agent's OpenRouter credential is read by the harness
 * from the app's own auth store (safeStorage); set OPENROUTER_API_KEY in the
 * env if it isn't saved in the app.
 *
 * See .claude/skills/harness-verify for the full guide.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}
const flag = (name) => process.argv.includes(`--${name}`);

const title = arg('title', '');
const untilUserText = arg('until', 'make it sunny');
const modelId = arg('model', 'moonshotai/kimi-k2.6');
const provider = arg('provider', 'openrouter');
const thinkingLevel = arg('thinking', 'high');
const repeat = parseInt(arg('repeat', '3'), 10);
const variantsArg = arg('variants', 'baseline,fix');
const variants = variantsArg.split(',').map((s) => s.trim()).filter(Boolean);
const dry = flag('dry');

// ── 1. Resolve the chat from conversations.json ────────────────────────────
const appData =
  process.env.APPDATA ||
  (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : path.join(os.homedir(), '.config'));
const convFile = path.join(appData, 'ModMixer', 'conversations.json');
if (!fs.existsSync(convFile)) {
  console.error(`conversations.json not found at ${convFile}`);
  process.exit(2);
}
const { conversations } = JSON.parse(fs.readFileSync(convFile, 'utf8'));
const matches = conversations
  .filter(
    (c) =>
      !title ||
      (c.title || '').toLowerCase().includes(title.toLowerCase()) ||
      (c.scope?.modFolder || '').toLowerCase().includes(title.toLowerCase()),
  )
  .sort((a, b) => b.updatedAt - a.updatedAt);
if (matches.length === 0) {
  console.error(`No conversation matching "${title}".`);
  process.exit(2);
}
const convo = matches[0];
console.error(
  `[run] chat: "${convo.title}"  scope=${JSON.stringify(convo.scope)}\n[run] session: ${convo.sessionFile}`,
);
if (!fs.existsSync(convo.sessionFile)) {
  console.error(`session file missing: ${convo.sessionFile}`);
  process.exit(2);
}

const config = {
  sessionFile: convo.sessionFile,
  scope: convo.scope,
  // The conversation's game drives which system prompt + tool set is built
  // (RimWorld default; Minecraft for NeoForge chats). Mirrors the app, which
  // reads convo.game / the mod's prefs. Without this a Minecraft chat would
  // replay against the RimWorld prompt.
  game: convo.game ?? 'rimworld',
  // Live conversations replay with the live prompt + tool set; the variants
  // then A/B the live system prompt (see replay.ts).
  live: convo.live === true,
  model: { provider, modelId },
  thinkingLevel,
  untilUserText,
  variants,
  repeat,
  dry,
};

// ── 2. Bundle replay.ts → self-contained Electron-main CJS ──────────────────
// Bundle everything (incl. the ESM SDK) into CJS so there is no runtime
// require() of an ESM-only package. Only true native addons + electron stay
// external — they're require()d at runtime under the real Electron ABI.
// CJS output: native require() resolves Node builtins + external native
// addons under Electron's ABI (an ESM bundle chokes on bundled CJS deps like
// chalk that require() builtins). The only ESM-ism the graph needs is
// `import.meta.url` (the SDK uses it for harmless package detection) — shim
// it to the bundle's own file URL via the banner + define below.
const outFile = path.join(here, '.out', 'replay.cjs');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
console.error('[run] bundling replay.ts…');
await build({
  entryPoints: [path.join(here, 'replay.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'error',
  banner: {
    js: "const __import_meta_url = require('url').pathToFileURL(__filename).href;",
  },
  define: { 'import.meta.url': '__import_meta_url' },
  external: [
    'electron',
    'better-sqlite3',
    'steamworks.js',
    '@vscode/ripgrep',
    'web-tree-sitter',
    'posthog-node',
    '@sentry/electron',
    'sharp',
    'fsevents',
  ],
});
console.error('[run] bundle ready.');

// ── 3. Pin Electron arch (matches scripts/dev-start.mjs) ────────────────────
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
const archEnv = detectElectronArch();

// Resolve the electron binary path from the package.
const electronBin = (await import('electron')).default;

console.error(
  `[run] launching electron (arch=${archEnv}) — ${dry ? 'DRY' : `${variants.join('+')} ×${repeat}`}…\n`,
);
const child = spawn(electronBin, [outFile], {
  stdio: 'inherit',
  env: {
    ...process.env,
    npm_config_arch: archEnv,
    MM_HARNESS_CONFIG: JSON.stringify(config),
    // Point the harness Electron at the real ModMixer userData so it reads
    // the user's saved OpenRouter credential + settings (not %APPDATA%\Electron).
    MM_USERDATA: path.join(appData, 'ModMixer'),
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
  shell: false,
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
