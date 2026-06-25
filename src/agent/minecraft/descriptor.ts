/**
 * Minecraft's renderer-safe descriptor (identity, display, capability flags).
 * Lives in the game's own folder so all per-game data is co-located, but stays
 * pure data — no electron/node/adapters imports — because the renderer imports
 * it directly via games/registry.ts. The purity test guards that invariant.
 */
import type { GameDefinition } from '../games/types.js';

export const minecraftDescriptor: GameDefinition = {
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
  // Nest index/lore/caches under .../minecraft/ so they never collide with
  // RimWorld's un-namespaced root.
  storageSegment: 'minecraft',
  beta: true,
};
