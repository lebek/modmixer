/**
 * RimWorld's read-only research tools: installed-mod inspection (loose folders +
 * .NET decompile) and the XML-def / C#-symbol / source index lookups. The index
 * mechanism is shared in tools/*; this module owns RimWorld's corpus-specific
 * presentation (labels, param docs, readiness messages, C# wording) so none of
 * it leaks into the shared tool files.
 */
import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { getIndexStatus } from '../index/rebuild.js';
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
import { listInstalledModsTool } from '../tools/list-installed-mods.js';
import { decompileDllTool } from '../tools/decompile-dll.js';

/** RimWorld's index builds from Settings (or the startup warm-cache). */
function notReady(msg: string): () => string | null {
  return () => {
    const status = getIndexStatus();
    return status.type === 'absent' || status.type === 'no-rimworld'
      ? msg
      : null;
  };
}

const searchDefsSpec: SearchDefsSpec = {
  label: 'Search defs',
  description:
    "Look up XML defs in the indexed Core + DLCs corpus. Three modes in one tool:\n\n• default — search by defName / label / description / abstract Name. Pass a single keyword (\"Pirate\") or a few whitespace-separated terms (\"BaseHuman raider\") — terms are AND'd. Abstract defs (those with `Name=\"…\"` and no `defName`, e.g. `FactionBase`) are matched on their Name attribute. When exactly one def matches, the full merged XML is returned inline.\n• descendantsOf=<Name> — find every def that extends a parent via ParentName (e.g. \"BaseFilth\"). Pass recursive=true to walk transitively.\n• referencedBy=<defName> — find every C# source location that mentions this defName by string literal.\n\nTemplate-fetch idiom: when you know the exact defName and just want its full XML to copy from (e.g. \"show me the Pirate FactionDef as a template\"), call with `limit=1` (and optionally `merged=true` to fold ParentName inheritance inline). That collapses the common search → identify → re-fetch chain into one call.\n\nThis tells you what XML data exists. For code BEHAVIOR (how does X work, why isn't Y firing, what's the right API pattern) start with search_source or read_symbol — the def database can't tell you how the engine consumes a def. Zero results here doesn't mean nothing exists; it usually means the answer lives in C# source, not XML.",
  params: Type.Object({
    query: Type.String({
      description:
        'Search term. Matched against defName (substring), label, and description (FTS). Empty string returns the first results filtered only by defType/pack. Ignored when descendantsOf or referencedBy is set.',
    }),
    defType: Type.Optional(
      Type.String({
        description:
          'Filter to a single XML def type (e.g. "ThingDef", "JobDef", "RecipeDef"). Omit to search all types.',
      }),
    ),
    pack: Type.Optional(
      Type.String({
        description:
          'Filter to a single pack: "Core", a DLC name ("Royalty"/"Ideology"/etc.), or "Mod:<id>" for a user mod. Omit to search everything.',
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
          'When a single def matches, return its full XML with ParentName inheritance folded in. Default true (merged); pass false for the raw authored XML.',
      }),
    ),
    descendantsOf: Type.Optional(
      Type.String({
        description:
          'Set to find every def that extends a given parent via ParentName="..." (e.g. "BaseFilth"). Mutually exclusive with query / referencedBy.',
      }),
    ),
    recursive: Type.Optional(
      Type.Boolean({
        description:
          'For descendantsOf: walk transitive children (descendants of descendants). Default false (one level).',
      }),
    ),
    referencedBy: Type.Optional(
      Type.String({
        description:
          'Set to a defName to find every C# location that references it by string literal. Bridges the def index and the source index — answers "what code reads this def?".',
      }),
    ),
  }),
  notReady: notReady(
    'RimWorld source index is not built yet. Open Settings → RimWorld index → Rebuild, or wait for the startup index to finish.',
  ),
};

const searchSourceSpec: SearchSourceSpec = {
  label: 'Search RimWorld source',
  description:
    'Ripgrep over the decompiled RimWorld C# source AND the indexed Defs XML. Use for finding call sites ("StealAIUtility\\\\b"), patch targets, def cross-references like `<li>Designator_AreaHomeExpand</li>`, attribute values, or any pattern that isn\'t a clean type/method name. For symbol-level C# lookup (by short name or FQN) prefer read_symbol; for def-by-name lookup prefer search_defs. Zero matches here often means the answer lives in an XML def — try search_defs as the fallback.',
  params: Type.Object({
    query: Type.String({
      description:
        'Regex pattern (ripgrep syntax) to search for in the decompiled RimWorld C# source AND the indexed Defs XML. Anchor with `\\b` for whole-word matches.',
    }),
    caseSensitive: Type.Optional(
      Type.Boolean({ description: 'Match case (default false).' }),
    ),
    filePattern: Type.Optional(
      Type.String({
        description:
          'Glob to restrict matches (e.g. "**/Verse/AI/*.cs" for C# only, "**/*.xml" for Defs only, "**/Designations/*.xml" for a single Defs subdir). Default: every file under both the C# source corpus and the Defs XML corpus.',
      }),
    ),
    maxLines: Type.Optional(
      Type.Number({
        description: 'Hard cap on total result lines (default 200, max 800).',
      }),
    ),
  }),
  notReady: notReady(
    'RimWorld source index is not built yet (or built without C# decompile). Open Settings → RimWorld index → Rebuild.',
  ),
  corpusName: 'RimWorld C# source and Defs XML index',
};

const symbolLang: SymbolLang = {
  noNamedSymbol: (name, kind) =>
    `No C# symbol named "${name}"${kind ? ` (kind=${kind})` : ''} in the indexed source. Try search_source for substring matches in C# / XML, or search_defs if "${name}" might be an XML def.`,
  noMatchingSymbol: (name, kind) =>
    `No C# symbol found matching "${name}"${kind ? ` (kind=${kind})` : ''}. Try search_source for substring matches, or search_defs if it might be an XML def.`,
  importLine: (m: SymbolMatch) => `    using:  ${m.namespace ?? '<global>'};`,
  showExtensionMethods: true,
};

const readSymbolSpec: ReadSymbolSpec = {
  label: 'Read C# symbol',
  description:
    "Look up a C# type or member in the decompiled RimWorld source. Handles both 'what is this and where does it live' and 'show me the body' in one call:\n\n• Pass a bare short name (\"DrawAt\", \"WorkTypeDef\") → returns the body when one symbol matches, or every candidate body inlined when only a few symbols share the name (no follow-up call needed). When many symbols share the name, returns the symbol-table entries instead — namespace, kind, FQN, signature — so you can pick one.\n• Pass a partial FQN (\"LetterMaker.MakeLetter\") or full FQN (\"RimWorld.LetterMaker.MakeLetter\") → returns the symbol body. All overloads are returned together when ambiguous.\n\nFor textual occurrences (call sites, string literals), use search_source. For XML def lookup, use search_defs.",
  params: Type.Object({
    name: Type.String({
      description:
        'Symbol to look up. Accepts (a) a bare short name like "DrawAt" or "WorkTypeDef" — returns the body when one symbol matches, every candidate body inlined when only a few share the name, or a disambiguation list with namespace + signature when many do; (b) a partial FQN like "LetterMaker.MakeLetter" — returns the body if unique, all overloads if not; (c) a full FQN like "RimWorld.LetterMaker.MakeLetter" — returns just that one body.',
    }),
    kind: Type.Optional(
      Type.String({
        description:
          'Optional kind filter: "class" | "struct" | "interface" | "enum" | "record" | "delegate" | "method" | "constructor" | "property" | "indexer" | "field" | "event".',
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
    'RimWorld source index is not built yet. Open Settings → RimWorld index → Rebuild.',
  ),
  lang: symbolLang,
};

const readLoreText = {
  label: 'Read modding lore',
  description:
    'Read transferable RimWorld-modding lessons for a given topic, merged across the lore tiers (repo → user). Each entry is a markdown section starting with an `## ` hook line. When entries from different tiers cover the same hook, prefer the more specific tier (user > repo) — they are returned in that order so later entries override earlier ones. Call this BEFORE attempting work in an unfamiliar area (e.g. before authoring a new SoundDef, before patching weather, before adding Harmony) — most of these lessons document non-obvious gotchas that took a long time to discover.',
};

const saveLoreText = {
  label: 'Save modding lore',
  description:
    'Persist a transferable engine-level modding lesson into the user-global lore so future sessions can consult it. Save sparingly — only when the lesson is broadly applicable across mods AND would NOT be obvious to an agent reading the code cold AND would have saved you significant time. Strong signals: the obvious approach failed, an error message was distinctive, the user corrected your assumption, the fix turned out to be in a different file/system than you first searched. Re-use an existing hook to update a lesson rather than appending a near-duplicate. Do NOT save mod-specific quirks here.',
};

export function rimworldResearchTools(): AgentTool<any>[] {
  return [
    listInstalledModsTool,
    decompileDllTool,
    createSearchDefsTool('rimworld', searchDefsSpec),
    createReadCsharpSymbolTool('rimworld', readSymbolSpec),
    createSearchSourceTool('rimworld', searchSourceSpec),
    createReadLoreTool('rimworld', readLoreText),
    createSaveLoreTool('rimworld', saveLoreText),
  ];
}
