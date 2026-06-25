/**
 * RimWorld's renderer-safe descriptor (identity, display, capability flags).
 * Lives in the game's own folder so all per-game data is co-located, but stays
 * pure data — no electron/node/adapters imports — because the renderer imports
 * it directly via games/registry.ts. The purity test guards that invariant.
 */
import type { GameDefinition } from '../games/types.js';
import {
  rimworldLoreTopics,
  rimworldLoreTopicHints,
} from './lore-taxonomy.js';

export const rimworldDescriptor: GameDefinition = {
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
    communityLore: true,
    folderImport: true,
    testBridgeInstall: true,
    runningGameControl: true,
    defScan: true,
  },
  buildTool: 'dotnet',
  lore: { topics: rimworldLoreTopics, topicHints: rimworldLoreTopicHints },
  indexPhaseLabels: {
    toolchain: 'Preparing the .NET build toolchain',
    defs: 'Indexing defs',
    decompile: 'Decompiling RimWorld assemblies',
    symbols: 'Indexing C# symbols',
  },
  setupSteps: ['setup'],
  // Legacy un-namespaced storage root: existing index/ and lore/ dirs predate
  // multi-game support, so RimWorld keeps the bare base path.
  storageSegment: '',
  beta: false,
};
