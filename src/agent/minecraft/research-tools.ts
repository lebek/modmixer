/**
 * Minecraft's read-only research tools: jar-manifest mod inspection and the
 * data-JSON / Java-symbol / source index lookups. The index mechanism is shared
 * in tools/*; this module owns Minecraft's corpus-specific presentation (labels,
 * param docs, lazy-build readiness messages, Java wording) so none of it leaks
 * into the shared tool files.
 */
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { ensureMinecraftIndexInBackground } from '../index/rebuild-minecraft.js';
import type { SymbolMatch } from '../index/resolve-symbol.js';
import {
  createSearchDefsTool,
  type SearchDefsSpec,
} from '../tools/search-defs.js';
import {
  createSearchSourceTool,
  type SearchSourceSpec,
} from '../tools/search-source.js';
import {
  createReadCsharpSymbolTool,
  type ReadSymbolSpec,
  type SymbolLang,
} from '../tools/read-csharp-symbol.js';
import { createReadLoreTool } from '../tools/read-lore.js';
import { createSaveLoreTool } from '../tools/save-lore.js';
import { mcListInstalledModsTool } from '../tools/list-installed-mods-mc.js';
import { inspectModTool } from '../tools/inspect-mod.js';

/**
 * The Minecraft index builds lazily on first use (one-time decompile, no
 * Settings UI yet), so an absent index is kicked off in the background here.
 */
function notReady(
  buildingMsg: string,
  absentMsg: string,
): () => string | null {
  return () => {
    const status = ensureMinecraftIndexInBackground();
    if (status === 'fresh') return null;
    return status === 'building' ? buildingMsg : absentMsg;
  };
}

const searchDefsSpec: SearchDefsSpec = {
  label: 'Search Minecraft data',
  description:
    'Look up Minecraft data/asset JSON in the indexed vanilla corpus by namespaced id. Search recipes, loot tables, tags, advancements, worldgen, models, blockstates, and lang (e.g. "diamond_sword", "oak_planks"). Filter by defType (recipe, loot_table, tags, advancement, models, blockstates, lang). When exactly one entry matches, its full JSON is returned inline — handy as a template to copy from. For Java code BEHAVIOR (how a registry/event works) use read_symbol or search_source instead.',
  params: Type.Object({
    query: Type.String({
      description:
        'Search term, matched against the entry id (substring) and indexed text (FTS) — e.g. "diamond_sword", "oak_planks". Empty string returns the first results filtered only by defType.',
    }),
    defType: Type.Optional(
      Type.String({
        description:
          'Filter to a single data category, e.g. "recipe", "loot_table", "tags", "advancement", "models", "blockstates", "lang". Omit to search all.',
      }),
    ),
    pack: Type.Optional(
      Type.String({
        description:
          'Filter to a single namespace (e.g. "minecraft"). Omit to search everything.',
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: 'Max rows to return (default 25, hard cap 200).',
      }),
    ),
    merged: Type.Optional(
      Type.Boolean({
        description:
          'RimWorld-only (folds ParentName inheritance into one def). No effect on Minecraft data — omit.',
      }),
    ),
    descendantsOf: Type.Optional(
      Type.String({
        description:
          'RimWorld-only (def inheritance via ParentName). Not applicable to Minecraft data — omit.',
      }),
    ),
    recursive: Type.Optional(
      Type.Boolean({
        description:
          'RimWorld-only companion to descendantsOf. Not applicable to Minecraft — omit.',
      }),
    ),
    referencedBy: Type.Optional(
      Type.String({
        description:
          'RimWorld-only (finds C# code referencing a defName). Not applicable to Minecraft — use search_source over the Java sources instead.',
      }),
    ),
  }),
  notReady: notReady(
    'The Minecraft index is still building (one-time decompile, a few minutes). Try again shortly.',
    "The Minecraft index isn't built yet — I just started it in the background. Try again shortly.",
  ),
};

const searchSourceSpec: SearchSourceSpec = {
  label: 'Search Minecraft source',
  description:
    "Ripgrep over the decompiled Minecraft + NeoForge Java source (mojmap + Parchment names). Use for finding call sites, event/registry usage, vanilla behaviour, or any pattern that isn't a clean type/method name. For symbol-level lookup (a Java class/method by name) prefer read_symbol.",
  params: Type.Object({
    query: Type.String({
      description:
        'Regex pattern (ripgrep syntax) to search across the decompiled Minecraft + NeoForge Java source (mojmap + Parchment names). Anchor with `\\b` for whole-word matches.',
    }),
    caseSensitive: Type.Optional(
      Type.Boolean({ description: 'Match case (default false).' }),
    ),
    filePattern: Type.Optional(
      Type.String({
        description:
          'Glob to restrict matches (e.g. "**/world/item/*.java" for one package, or "**/*.java"). Default: every indexed Java source file.',
      }),
    ),
    maxLines: Type.Optional(
      Type.Number({
        description: 'Hard cap on total result lines (default 200, max 800).',
      }),
    ),
  }),
  notReady: notReady(
    'The Minecraft code index is still building (one-time decompile, a few minutes). Try again shortly — do other work meanwhile.',
    "The Minecraft code index isn't built yet — I just started it in the background (one-time decompile, a few minutes). Try again shortly.",
  ),
  corpusName: 'Minecraft + NeoForge Java source',
};

const symbolLang: SymbolLang = {
  noNamedSymbol: (name, kind) =>
    `No Java symbol named "${name}"${kind ? ` (kind=${kind})` : ''} in the indexed Minecraft + NeoForge source. Try search_source for substring matches, or search_defs if "${name}" might be a data/asset JSON id.`,
  noMatchingSymbol: (name, kind) =>
    `No Java symbol found matching "${name}"${kind ? ` (kind=${kind})` : ''}. Try search_source for substring matches, or search_defs if it might be a data/asset JSON id.`,
  importLine: (m: SymbolMatch) => `    import: ${m.fqn};`,
  showExtensionMethods: false,
};

const readSymbolSpec: ReadSymbolSpec = {
  label: 'Read Java symbol',
  description:
    'Look up a Java type or member in the decompiled Minecraft + NeoForge source (mojmap + Parchment names). Pass a bare short name ("DeferredRegister", "RegisterEvent", "BlockBehaviour") → returns the body when one symbol matches, or candidate bodies inlined when a few share the name; pass a partial/full FQN ("net.neoforged.neoforge.registries.DeferredRegister") → returns that body. For textual occurrences (call sites, usages) use search_source.',
  params: Type.Object({
    name: Type.String({
      description:
        'Symbol to look up. Accepts (a) a bare short name like "DeferredRegister" or "BlockBehaviour" — returns the body when one symbol matches, every candidate body inlined when only a few share the name, or a disambiguation list with package + signature when many do; (b) a partial FQN like "registries.DeferredRegister"; (c) a full FQN like "net.neoforged.neoforge.registries.DeferredRegister" — returns just that one body.',
    }),
    kind: Type.Optional(
      Type.String({
        description:
          'Optional kind filter: "class" | "interface" | "enum" | "record" | "method" | "constructor" | "field".',
      }),
    ),
    maxBytes: Type.Optional(
      Type.Number({
        description:
          'Per-symbol body cap in bytes. Default 4096; raise this when you need more context (max 32768).',
      }),
    ),
  }),
  notReady: notReady(
    'The Minecraft code index is still building (one-time decompile, a few minutes). Try again shortly.',
    "The Minecraft code index isn't built yet — I just started it in the background. Try again shortly.",
  ),
  lang: symbolLang,
};

const readLoreText = {
  label: 'Read Minecraft modding lore',
  description:
    'Read transferable Minecraft (NeoForge) modding lessons for a given topic, merged across the lore tiers (repo → user). Each entry is a markdown section starting with an `## ` hook line; user entries override repo on the same hook. Call this BEFORE work in an unfamiliar area (registering blocks/items, events, datagen, mixins, networking) — the lessons capture non-obvious NeoForge gotchas.',
};

const saveLoreText = {
  label: 'Save Minecraft modding lore',
  description:
    'Persist a transferable Minecraft (NeoForge) modding lesson into the Minecraft lore so future sessions can consult it. Save sparingly — only when the lesson is broadly applicable across mods AND would NOT be obvious to an agent reading the code cold AND would have saved you significant time. Strong signals: the obvious approach failed, an error message was distinctive, the user corrected your assumption, the fix turned out to be in a different file/system than you first searched. Re-use an existing hook to update a lesson rather than appending a near-duplicate. Do NOT save mod-specific quirks here.',
};

export function minecraftResearchTools(): AgentTool<any>[] {
  return [
    mcListInstalledModsTool,
    inspectModTool,
    createSearchDefsTool('minecraft', searchDefsSpec),
    createReadCsharpSymbolTool('minecraft', readSymbolSpec),
    createSearchSourceTool('minecraft', searchSourceSpec),
    createReadLoreTool('minecraft', readLoreText),
    createSaveLoreTool('minecraft', saveLoreText),
  ];
}
