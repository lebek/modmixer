import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `src/agent/games/` is the renderer-safe descriptor layer — ~10 React
 * components import getGame/capabilities from it directly. If it ever pulls in
 * `electron`, a `node:*` builtin, or the main-only `adapters/` behavior layer,
 * those leak into the renderer bundle (and break the GameAdapter split). This
 * test fails fast if that invariant is violated. See adapters/types.ts.
 */
const forbidden: Array<{ label: string; re: RegExp }> = [
  { label: 'electron', re: /from\s+['"]electron['"]/ },
  { label: 'node: builtin', re: /from\s+['"]node:/ },
  {
    label: 'adapters/ (main-only behavior)',
    re: /from\s+['"][^'"]*adapters[/'"]/,
  },
];

function assertRendererSafe(file: string, src: string): void {
  for (const { label, re } of forbidden) {
    assert.ok(
      !re.test(src),
      `${file} must not import ${label} — it would leak into the renderer bundle`,
    );
  }
}

describe('games/ stays renderer-safe', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const gamesDir = path.join(dir, '..');
  const sources = fs
    .readdirSync(gamesDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));

  for (const file of sources) {
    it(`${file} imports nothing main-only`, () => {
      assertRendererSafe(file, fs.readFileSync(path.join(gamesDir, file), 'utf8'));
    });
  }
});

/**
 * Each game's descriptor lives in its own folder (a folder that ALSO holds
 * main-only behavior modules), but the descriptor itself is imported by the
 * renderer-safe registry, so it must stay as pure as games/ does.
 */
describe('per-game descriptors stay renderer-safe', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const descriptors = ['rimworld', 'minecraft'].map((g) =>
    path.join(dir, '..', '..', g, 'descriptor.ts'),
  );

  for (const file of descriptors) {
    it(`${path.relative(path.join(dir, '..', '..'), file)} imports nothing main-only`, () => {
      assertRendererSafe(file, fs.readFileSync(file, 'utf8'));
    });
  }
});
