import type { GameDefinition, GameId } from './types.js';

/**
 * The game everything defaults to. Mods, conversations, and settings written
 * before multi-game support resolve to RimWorld, so nothing about the existing
 * single-game experience changes.
 */
export const DEFAULT_GAME_ID: GameId = 'rimworld';

const RIMWORLD: GameDefinition = {
  id: 'rimworld',
  displayName: 'RimWorld',
  shortLabel: 'RimWorld',
  badgeClassName: 'bg-amber-500/15 text-amber-300 border border-amber-500/30',
  capabilities: {
    steamWorkshop: true,
    publish: 'steam-workshop',
    assetPanel: true,
    depsPanel: true,
    liveSession: true,
    testLoop: true,
    sourceIndex: true,
  },
  buildTool: 'dotnet',
  beta: false,
};

const MINECRAFT: GameDefinition = {
  id: 'minecraft',
  displayName: 'Minecraft',
  shortLabel: 'Minecraft (NeoForge)',
  badgeClassName:
    'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30',
  capabilities: {
    steamWorkshop: false,
    publish: 'modrinth',
    // Disabled for the beta — the RimWorld asset scanner + sprite preview are
    // Textures/Sounds-specific; Minecraft mods supply Modrinth gallery images.
    assetPanel: false,
    // RimWorld About.xml dependency editor; Minecraft deps live in the
    // generated neoforge.mods.toml (no panel).
    depsPanel: false,
    // No in-game hot-edit session for the beta (RimWorld's is Verse-specific).
    liveSession: false,
    testLoop: true,
    sourceIndex: true,
  },
  buildTool: 'gradle',
  beta: true,
};

const GAMES: Record<GameId, GameDefinition> = {
  rimworld: RIMWORLD,
  minecraft: MINECRAFT,
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
  return [RIMWORLD, MINECRAFT];
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
