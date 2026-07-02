import { openIndexDb } from './db.js';
import { getAdapter } from '../adapters/index.js';
import type { GameId } from '../games/types.js';
import { resolveSymbolFromDb, type SymbolMatch } from './resolve-symbol-core.js';

// Pure, dependency-light helpers (types + DB-free enrichment) live in
// ./resolve-symbol-core.js and are re-exported here so existing importers are
// unaffected. Keeping them out of this module lets their unit tests run without
// loading the game-adapter graph (agent runtime + ESM-only deps).
export * from './resolve-symbol-core.js';

/**
 * Look up a symbol by short name. Returns every match across the corpus,
 * with namespace + extension-method enrichment. Empty array means either
 * "no such symbol" or "index not built" — callers that care should check
 * the index status first.
 *
 * Capped at 25 matches (matches read_symbol). For something with
 * thousands of hits (e.g. `Equals`) the agent should narrow with `kind`.
 */
export function resolveSymbol(
  shortName: string,
  options: { kind?: string; limit?: number; game?: GameId } = {},
): SymbolMatch[] {
  const game = options.game ?? 'rimworld';
  // Some games (RimWorld) must not touch a never-built DB; their adapter gates
  // the query on index status. Others create per-game DBs empty on open and just
  // return [] if absent (the calling tool has already checked the index status).
  if (!getAdapter(game).index.symbolDbReady()) return [];
  return resolveSymbolFromDb(openIndexDb(game), shortName, options);
}
