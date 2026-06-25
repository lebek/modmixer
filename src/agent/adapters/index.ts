/**
 * Adapter registry — `getAdapter(game)` is the single dispatch point for
 * per-game behavior, the behavioral counterpart to games/registry.ts's
 * declarative `getGame(game)`. Main-process only (adapters pull in node/electron
 * modules); the renderer gates on `getGame(game).capabilities` instead.
 */
import type { GameId } from '../games/types.js';
import type { GameAdapter } from './types.js';
import { RimWorldAdapter } from '../rimworld/adapter.js';
import { MinecraftAdapter } from '../minecraft/adapter.js';

const ADAPTERS: Record<GameId, GameAdapter> = {
  rimworld: RimWorldAdapter,
  minecraft: MinecraftAdapter,
};

export function getAdapter(game: GameId): GameAdapter {
  return ADAPTERS[game];
}

export type {
  GameAdapter,
  BuildModDetails,
  RunTestCycleDetails,
  TestCycleContext,
} from './types.js';
