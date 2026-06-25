import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The "game opaque" guardrail. Multi-game support is meant to flow through one
 * seam: the renderer-safe descriptor (games/ + each `<game>/descriptor.ts`,
 * dispatched by getGame/capabilities) and the main-only adapter (adapters/ +
 * each `<game>/*`, dispatched by getAdapter). Everywhere else, the game is meant
 * to be opaque — code should branch on a capability flag or call an adapter
 * method, never on the game id.
 *
 * This test fails if a raw game-id comparison (`game === 'minecraft'`, an `isMc`
 * helper, etc.) appears OUTSIDE that seam. When it trips, the fix is almost
 * never to add a path to the allowlist — it's to add a capability/descriptor
 * field or an adapter method and dispatch through it. See games/types.ts
 * (GameCapabilities) and adapters/types.ts (GameAdapter).
 */
describe('game id never leaks outside the per-game seam', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const srcRoot = path.join(dir, '..', '..', '..');

  // The only places allowed to branch on a concrete game id: the registry (which
  // DEFINES the GameId set and its guards), the adapter dispatch layer, and a
  // game's own implementation folder (which legitimately knows which game it is).
  const ALLOWED_PREFIXES = [
    path.join(srcRoot, 'agent', 'games'),
    path.join(srcRoot, 'agent', 'adapters'),
    path.join(srcRoot, 'agent', 'rimworld'),
    path.join(srcRoot, 'agent', 'minecraft'),
  ];

  // Raw game-id discriminators: an equality/inequality test against the id
  // literal (either operand order), or the legacy `isMc` shorthand.
  const PATTERNS: RegExp[] = [
    /(?:===|!==)\s*['"](?:rimworld|minecraft)['"]/,
    /['"](?:rimworld|minecraft)['"]\s*(?:===|!==)/,
    /\bisMc\b/,
  ];

  function isAllowed(file: string): boolean {
    return ALLOWED_PREFIXES.some((p) => file.startsWith(p + path.sep));
  }

  function walk(dirPath: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        out.push(...walk(full));
      } else if (
        (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
        !entry.name.endsWith('.d.ts')
      ) {
        out.push(full);
      }
    }
    return out;
  }

  it('no raw game-id branch outside games/ adapters/ rimworld/ minecraft/', () => {
    const violations: string[] = [];
    for (const file of walk(srcRoot)) {
      if (isAllowed(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (PATTERNS.some((re) => re.test(line))) {
          violations.push(`${path.relative(srcRoot, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(
      violations,
      [],
      `Game id branched on outside the per-game seam. Dispatch through a ` +
        `capability flag or an adapter method instead:\n${violations.join('\n')}`,
    );
  });
});
