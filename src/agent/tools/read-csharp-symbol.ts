import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { openIndexDb } from '../index/db.js';
import { getIndexStatus } from '../index/rebuild.js';
import {
  getMinecraftIndexStatus,
  ensureMinecraftIndexInBackground,
} from '../index/rebuild-minecraft.js';
import { getIndexPaths } from '../index/paths.js';
import { resolveSymbol, type SymbolMatch } from '../index/resolve-symbol.js';
import type { GameId } from '../games/types.js';

/** Game-aware "index not ready" message; lazily triggers the MC build. */
function symbolIndexNotReady(game: GameId): string | null {
  if (game === 'minecraft') {
    const status = ensureMinecraftIndexInBackground();
    if (status === 'fresh') return null;
    if (status === 'building')
      return 'The Minecraft code index is still building (one-time decompile, a few minutes). Try again shortly.';
    return "The Minecraft code index isn't built yet — I just started it in the background. Try again shortly.";
  }
  const status = getIndexStatus();
  if (status.type === 'absent' || status.type === 'no-rimworld') {
    return 'RimWorld source index is not built yet. Open Settings → RimWorld index → Rebuild.';
  }
  return null;
}

const Params = Type.Object({
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
});

interface SymbolHit {
  fqn: string;
  shortName: string;
  kind: string;
  parentFqn: string | null;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string | null;
  body: string;
  truncated: boolean;
}

interface ResolveOnlyDetails {
  matches: SymbolMatch[];
}

// When a bare short name hits a small handful of distinct FQNs, inline every
// candidate's body instead of returning a list the agent must re-query one
// FQN at a time. Past either bound, fall back to the disambiguation list.
const INLINE_FQN_LIMIT = 3;
const INLINE_BYTE_BUDGET = 6144;

export function createReadCsharpSymbolTool(
  game: GameId = 'rimworld',
): AgentTool<typeof Params, { hits: SymbolHit[]; matches?: SymbolMatch[] }> {
  const isMc = game === 'minecraft';
  return {
  name: 'read_csharp_symbol',
  label: isMc ? 'Read Java symbol' : 'Read C# symbol',
  description: isMc
    ? "Look up a Java type or member in the decompiled Minecraft + NeoForge source (mojmap + Parchment names). Pass a bare short name (\"DeferredRegister\", \"RegisterEvent\", \"BlockBehaviour\") → returns the body when one symbol matches, or candidate bodies inlined when a few share the name; pass a partial/full FQN (\"net.neoforged.neoforge.registries.DeferredRegister\") → returns that body. For textual occurrences (call sites, usages) use search_source."
    : "Look up a C# type or member in the decompiled RimWorld source. Handles both 'what is this and where does it live' and 'show me the body' in one call:\n\n• Pass a bare short name (\"DrawAt\", \"WorkTypeDef\") → returns the body when one symbol matches, or every candidate body inlined when only a few symbols share the name (no follow-up call needed). When many symbols share the name, returns the symbol-table entries instead — namespace, kind, FQN, signature — so you can pick one.\n• Pass a partial FQN (\"LetterMaker.MakeLetter\") or full FQN (\"RimWorld.LetterMaker.MakeLetter\") → returns the symbol body. All overloads are returned together when ambiguous.\n\nFor textual occurrences (call sites, string literals), use search_source. For XML def lookup, use search_defs.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<{ hits: SymbolHit[]; matches?: SymbolMatch[] }>> {
    const notReady = symbolIndexNotReady(game);
    if (notReady) {
      return {
        content: [{ type: 'text', text: notReady }],
        details: { hits: [] },
      };
    }

    const { sourceRoot } = getIndexPaths(game);

    // Bare short name (no dots) routes through `resolveSymbol` to pick out the
    // distinct FQNs that share this short name. If there's exactly one logical
    // symbol (possibly with overloads), drop into body-read mode using that
    // FQN. Multiple distinct FQNs → return the disambig list so the agent can
    // pick one — same as before. The single-FQN short-circuit saves the
    // read("IncidentWorker_Raid") → re-call("…_Raid") two-step that hit
    // repeatedly in run 2.
    let lookupName = params.name;
    if (!params.name.includes('.')) {
      const rawMatches = resolveSymbol(params.name, { kind: params.kind, game });
      if (rawMatches.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No C# symbol named "${params.name}"${params.kind ? ` (kind=${params.kind})` : ''} in the indexed source. Try search_source for substring matches in C# / XML, or search_defs if "${params.name}" might be an XML def.`,
            },
          ],
          details: { hits: [], matches: [] },
        };
      }
      const distinctFqns = new Set(rawMatches.map((m) => m.fqn));
      if (distinctFqns.size > 1) {
        const matches: SymbolMatch[] = rawMatches.map((m) => ({
          ...m,
          filePath: path.resolve(sourceRoot, m.filePath),
        }));
        // Small disambiguation set → inline every candidate's body so the
        // agent picks by reading code, not by spending one re-call per FQN.
        if (distinctFqns.size <= INLINE_FQN_LIMIT) {
          const inlined = await inlineMatchBodies(matches, INLINE_BYTE_BUDGET);
          if (inlined) {
            return {
              content: [{ type: 'text', text: inlined.text }],
              details: { hits: inlined.hits, matches },
            };
          }
        }
        return {
          content: [{ type: 'text', text: formatMatches(matches) }],
          details: { hits: [], matches },
        };
      }
      // Exactly one logical symbol — use its FQN downstream.
      lookupName = rawMatches[0].fqn;
    }

    // Dotted (or single-match bare) name → body-read mode.
    const db = openIndexDb(game);
    const cap = Math.min(Math.max(params.maxBytes ?? 4096, 256), 32768);
    const kindArgs: Record<string, unknown> = params.kind
      ? { kind: params.kind }
      : {};
    const kindClause = params.kind ? ' AND kind = @kind' : '';
    const select = `
      SELECT fqn, shortName, kind, parentFqn, filePath, startLine, endLine, signature
      FROM symbol
    `;
    const orderLimit = `
      ORDER BY length(fqn), fqn, startLine
      LIMIT 25
    `;
    type Row = Omit<SymbolHit, 'body' | 'truncated'>;
    const exactStmt = db.prepare(
      `${select} WHERE fqn = @name${kindClause} ${orderLimit}`,
    );
    const suffixStmt = db.prepare(
      `${select} WHERE fqn LIKE @suffix${kindClause} ${orderLimit}`,
    );

    // Peel-and-retry: indexed FQNs are stored without their C# namespace
    // (e.g. "Pawn_NeedsTracker.ShouldHaveNeed", not "RimWorld.Pawn_NeedsTracker.…").
    // When the model prepends a namespace it knows from `using …;` ("RimWorld.",
    // "Verse."), drop one leading component at a time and retry. This collapses
    // the previously-observed read_csharp_symbol("RimWorld.X.Y") → fail → retry
    // ("X.Y") → success pattern into one call.
    const variants: string[] = [lookupName];
    const parts = lookupName.split('.');
    for (let i = 1; i < parts.length; i++) {
      variants.push(parts.slice(i).join('.'));
    }

    let rows: Row[] = [];
    for (const candidate of variants) {
      rows = exactStmt.all({ name: candidate, ...kindArgs }) as Row[];
      if (rows.length > 0) break;
      rows = suffixStmt.all({ suffix: `%.${candidate}`, ...kindArgs }) as Row[];
      if (rows.length > 0) break;
    }

    if (rows.length === 0) {
      // Last-ditch fallback: drop the namespace prefix and try short-name
      // disambiguation. Catches "Effecter.Spawn" when the actual FQN is
      // "Verse.EffecterDef.Spawn" — the agent typed off a (wrong) memory.
      const tail = lookupName.split('.').pop() ?? lookupName;
      const rawMatches = resolveSymbol(tail, { kind: params.kind, game });
      if (rawMatches.length > 0) {
        const matches: SymbolMatch[] = rawMatches.map((m) => ({
          ...m,
          filePath: path.resolve(sourceRoot, m.filePath),
        }));
        return {
          content: [
            {
              type: 'text',
              text:
                `No symbol exactly matched "${params.name}". Closest matches by short name "${tail}":\n\n` +
                formatMatches(matches),
            },
          ],
          details: { hits: [], matches },
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `No C# symbol found matching "${params.name}"${params.kind ? ` (kind=${params.kind})` : ''}. Try search_source for substring matches, or search_defs if it might be an XML def.`,
          },
        ],
        details: { hits: [] },
      };
    }

    const hits: SymbolHit[] = [];
    for (const r of rows) {
      const abs = path.resolve(sourceRoot, r.filePath);
      let body = '';
      let truncated = false;
      try {
        const fileText = await fsp.readFile(abs, 'utf8');
        const lines = fileText.split(/\r?\n/);
        const slice = lines.slice(r.startLine - 1, r.endLine).join('\n');
        if (Buffer.byteLength(slice, 'utf8') > cap) {
          body = slice.slice(0, cap) + '\n// … (truncated; raise maxBytes for more)';
          truncated = true;
        } else {
          body = slice;
        }
      } catch {
        body = '<could not read source file>';
      }
      hits.push({ ...r, filePath: abs, body, truncated });
    }

    // Method overloads share an FQN — index them up front so the caller can
    // pick the right one by signature without a second tool call.
    const fqnGroups = new Map<string, SymbolHit[]>();
    for (const h of hits) {
      const list = fqnGroups.get(h.fqn) ?? [];
      list.push(h);
      fqnGroups.set(h.fqn, list);
    }
    const overloadIndex: string[] = [];
    for (const [fqn, group] of fqnGroups) {
      if (group.length < 2) continue;
      overloadIndex.push(
        `# ${group.length} overloads of ${fqn}:`,
        ...group.map(
          (h, i) =>
            `#   [${i + 1}] ${h.signature ?? '(no signature)'}  — ${h.filePath}:${h.startLine}`,
        ),
      );
    }
    const body = hits
      .map(
        (h) =>
          `=== ${h.kind} ${h.fqn} (${h.filePath}:${h.startLine}-${h.endLine}) ===\n${h.body}`,
      )
      .join('\n\n');
    const text =
      overloadIndex.length > 0
        ? `${overloadIndex.join('\n')}\n\n${body}`
        : body;
    return {
      content: [{ type: 'text', text }],
      details: { hits },
    };
  },
  };
}

/**
 * Read and inline the bodies of a small set of disambiguation candidates so
 * the agent doesn't have to re-call once per FQN. Returns null — caller falls
 * back to the bare list — when any file can't be read or the combined bodies
 * exceed `byteBudget`.
 */
async function inlineMatchBodies(
  matches: SymbolMatch[],
  byteBudget: number,
): Promise<{ text: string; hits: SymbolHit[] } | null> {
  const hits: SymbolHit[] = [];
  let total = 0;
  for (const m of matches) {
    let body: string;
    try {
      const fileText = await fsp.readFile(m.filePath, 'utf8');
      body = fileText
        .split(/\r?\n/)
        .slice(m.startLine - 1, m.endLine)
        .join('\n');
    } catch {
      return null;
    }
    total += Buffer.byteLength(body, 'utf8');
    if (total > byteBudget) return null;
    hits.push({
      fqn: m.fqn,
      shortName: m.shortName,
      kind: m.kind,
      parentFqn: m.parentFqn,
      filePath: m.filePath,
      startLine: m.startLine,
      endLine: m.endLine,
      signature: m.signature,
      body,
      truncated: false,
    });
  }
  const text =
    `Found ${matches.length} ${matches.length === 1 ? 'match' : 'matches'} — bodies inlined below. Pick the FQN you need; no follow-up call required.\n\n` +
    hits
      .map(
        (h) =>
          `=== ${h.kind} ${h.fqn} (${h.filePath}:${h.startLine}-${h.endLine}) ===\n${h.body}`,
      )
      .join('\n\n');
  return { text, hits };
}

function formatMatches(matches: SymbolMatch[]): string {
  const lines: string[] = [
    `Found ${matches.length} ${matches.length === 1 ? 'match' : 'matches'}. Re-call with the FQN to read the body:`,
    '',
  ];
  for (const m of matches) {
    const ns = m.namespace ?? '<global>';
    const ext = m.isExtensionMethod ? ' [extension method]' : '';
    lines.push(`* ${m.kind} ${m.fqn}${ext}`);
    lines.push(`    using:  ${ns};`);
    if (m.signature) lines.push(`    sig:    ${m.signature}`);
    lines.push(`    where:  ${m.filePath}:${m.startLine}-${m.endLine}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
