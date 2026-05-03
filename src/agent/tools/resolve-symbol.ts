import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import {
  resolveSymbol,
  type SymbolMatch,
} from '../index/resolve-symbol.js';
import { getIndexStatus } from '../index/rebuild.js';

const Params = Type.Object({
  name: Type.String({
    description:
      'Short name of the C# symbol you intend to use (e.g. "IsWorldPawn", "WorkTypeDef", "Find"). The tool returns the namespace each match belongs to so you know which `using …;` to add. Pass a short name; FQNs are not currently accepted.',
  }),
  kind: Type.Optional(
    Type.String({
      description:
        'Optional kind filter: "class" | "struct" | "interface" | "enum" | "record" | "delegate" | "method" | "constructor" | "property" | "indexer" | "field" | "event". Useful when a name is shared across kinds (e.g. a class and a method).',
    }),
  ),
});

export interface ResolveSymbolDetails {
  /** Empty when the index isn't built or the name has zero matches. */
  matches: SymbolMatch[];
}

const NO_INDEX_MSG =
  'RimWorld source index is not built yet. Open Settings → RimWorld index → Rebuild.';

/**
 * Sharp single-purpose lookup: "where is this symbol declared, and what
 * `using` do I need to call it?" Distinguishing this from `read_csharp_symbol`
 * (which returns the *body* of the symbol) and `search_source` (which returns
 * every textual occurrence) avoids the failure mode where the agent does a
 * broad grep just to figure out a namespace — that mode burned ~7k tokens in
 * a recent session for one missing using directive.
 */
export const resolveSymbolTool: AgentTool<typeof Params, ResolveSymbolDetails> =
  {
    name: 'resolve_symbol',
    label: 'Resolve C# symbol',
    description:
      "Look up a C# symbol's namespace and signature in the indexed RimWorld source. Use this proactively when you're about to call a RimWorld API but aren't sure which `using …;` it lives behind. Returns one line per candidate — namespace, kind, FQN, and an extension-method flag. Cheaper than search_source for the namespace question because it queries the symbol table directly instead of grepping every line.",
    parameters: Params,
    async execute(_id, params): Promise<AgentToolResult<ResolveSymbolDetails>> {
      const status = getIndexStatus();
      if (status.type === 'absent' || status.type === 'no-rimworld') {
        return {
          content: [{ type: 'text', text: NO_INDEX_MSG }],
          details: { matches: [] },
        };
      }
      const matches = resolveSymbol(params.name, { kind: params.kind });
      if (matches.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No C# symbol named "${params.name}"${
                params.kind ? ` (kind=${params.kind})` : ''
              } in the indexed source. Confirm spelling, or try search_source for substring matches.`,
            },
          ],
          details: { matches: [] },
        };
      }
      const text = formatMatches(matches);
      return {
        content: [{ type: 'text', text }],
        details: { matches },
      };
    },
  };

function formatMatches(matches: SymbolMatch[]): string {
  const lines: string[] = [
    `Found ${matches.length} ${matches.length === 1 ? 'match' : 'matches'}:`,
    '',
  ];
  for (const m of matches) {
    const ns = m.namespace ?? '<global>';
    const ext = m.isExtensionMethod ? ' [extension method]' : '';
    lines.push(`* ${m.kind} ${m.fqn}${ext}`);
    lines.push(`    using:  ${ns};`);
    if (m.signature) lines.push(`    sig:    ${m.signature}`);
    lines.push(
      `    where:  ${m.filePath}:${m.startLine}-${m.endLine}`,
    );
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
