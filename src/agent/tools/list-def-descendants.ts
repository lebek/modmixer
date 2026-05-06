import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import path from 'node:path';
import { openIndexDb } from '../index/db.js';
import { getIndexPaths } from '../index/paths.js';
import { getIndexStatus } from '../index/rebuild.js';

const Params = Type.Object({
  parent: Type.String({
    description:
      'The parent\'s Name="" attribute (the value other defs reference via ParentName="..."). For abstract bases like ThingDef Name="BaseFilth", pass "BaseFilth".',
  }),
  defType: Type.Optional(
    Type.String({
      description:
        'Optional defType filter. Matches the parent\'s defType — pass "ThingDef" if you only want ThingDef descendants of the parent.',
    }),
  ),
  recursive: Type.Optional(
    Type.Boolean({
      description:
        'When true, walk transitive children (descendants of descendants). Default false (one level).',
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: 'Max rows to return (default 50, hard cap 500).',
    }),
  ),
});

interface DescendantHit {
  pack: string;
  defType: string;
  defName: string | null;
  inheritName: string | null;
  filePath: string;
  /** How many ParentName hops away from the requested parent (1 for direct). */
  depth: number;
}

const NO_INDEX_MSG =
  'RimWorld source index is not built yet. Open Settings → RimWorld index → Rebuild.';

export const listDefDescendantsTool: AgentTool<typeof Params, { hits: DescendantHit[] }> = {
  name: 'list_def_descendants',
  label: 'List def descendants',
  description:
    "Find every def that extends a given parent via ParentName. Use this to answer 'what extends BaseFilth?' or 'show me every weapon that builds on BaseHumanGun'. Pass recursive=true to walk the full chain.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<{ hits: DescendantHit[] }>> {
    const status = getIndexStatus();
    if (status.type === 'absent' || status.type === 'no-rimworld') {
      return {
        content: [{ type: 'text', text: NO_INDEX_MSG }],
        details: { hits: [] },
      };
    }
    const db = openIndexDb();
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
    const recursive = params.recursive === true;

    const stmt = params.defType
      ? db.prepare(
          'SELECT pack, defType, defName, inheritName, filePath FROM def WHERE parentName = ? AND defType = ?',
        )
      : db.prepare(
          'SELECT pack, defType, defName, inheritName, filePath FROM def WHERE parentName = ?',
        );

    const seen = new Set<string>();
    const queue: { parent: string; depth: number }[] = [{ parent: params.parent, depth: 0 }];
    const hits: DescendantHit[] = [];
    // DB stores `filePath` relative to the def-index root; absolutize at the
    // tool boundary so the agent can pass paths straight to `read`.
    const { defsRoot } = getIndexPaths();

    while (queue.length > 0 && hits.length < limit) {
      const { parent, depth } = queue.shift()!;
      const rows = (
        params.defType
          ? stmt.all(parent, params.defType)
          : stmt.all(parent)
      ) as Omit<DescendantHit, 'depth'>[];
      for (const r of rows) {
        const key = `${r.pack}|${r.defType}|${r.defName ?? r.inheritName ?? '?'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({
          ...r,
          filePath: path.resolve(defsRoot, r.filePath),
          depth: depth + 1,
        });
        if (hits.length >= limit) break;
        if (recursive && r.inheritName) {
          queue.push({ parent: r.inheritName, depth: depth + 1 });
        }
      }
    }

    if (hits.length === 0) {
      return {
        content: [
          { type: 'text', text: `No defs extend "${params.parent}".` },
        ],
        details: { hits: [] },
      };
    }

    const lines = hits.map(
      (h) =>
        `${' '.repeat((h.depth - 1) * 2)}${h.pack} • ${h.defType} • ${h.defName ?? '(abstract: ' + h.inheritName + ')'}\n    ${h.filePath}`,
    );
    return {
      content: [
        {
          type: 'text',
          text:
            `Found ${hits.length} descendant${hits.length === 1 ? '' : 's'} of ${params.parent}.\n\n` +
            lines.join('\n'),
        },
      ],
      details: { hits },
    };
  },
};
