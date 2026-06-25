import type { GameDefinition, GameId } from './types.js';
import { rimworldDescriptor } from '../rimworld/descriptor.js';
import { minecraftDescriptor } from '../minecraft/descriptor.js';

/**
 * The game everything defaults to. Mods, conversations, and settings written
 * before multi-game support resolve to RimWorld, so nothing about the existing
 * single-game experience changes.
 */
export const DEFAULT_GAME_ID: GameId = 'rimworld';

/**
 * Central registry of game descriptors. Each game's descriptor lives in its own
 * folder (`<game>/descriptor.ts`, renderer-safe); this record is the closed map
 * the rest of the renderer-safe code dispatches over. Adding a game means a new
 * descriptor module + one line here (and its main-only adapter in adapters/).
 */
const GAMES: Record<GameId, GameDefinition> = {
  rimworld: rimworldDescriptor,
  minecraft: minecraftDescriptor,
};

export function isGameId(value: unknown): value is GameId {
  return value === 'rimworld' || value === 'minecraft';
}

/**
 * Coerce any persisted/user value to a known GameId, falling back to RimWorld.
 * Used wherever a stored `game` field is read so a missing/garbage value (an
 * old mod, a future game id this build doesn't know) degrades gracefully.
 */
export function resolveGameId(value: unknown): GameId {
  return isGameId(value) ? value : DEFAULT_GAME_ID;
}

export function getGame(id: GameId): GameDefinition {
  return GAMES[id];
}

/** Every defined game, including beta ones (use for lookup, not for pickers). */
export function listGames(): GameDefinition[] {
  return [rimworldDescriptor, minecraftDescriptor];
}

/**
 * Games a user may pick when creating a mod / in onboarding. All games are
 * always available — there is no per-game enable flag. A game that hasn't been
 * set up yet (paths discovered, index built) is set up lazily the first time
 * the user makes a mod for it, or manually from Settings → Games. The `beta`
 * flag is surfaced as a label, not a gate.
 */
export function getSelectableGames(): GameDefinition[] {
  return listGames();
}
