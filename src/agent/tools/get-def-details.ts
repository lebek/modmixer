import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import path from 'node:path';
import { openIndexDb } from '../index/db.js';
import { getIndexPaths } from '../index/paths.js';
import { getIndexStatus } from '../index/rebuild.js';

const Params = Type.Object({
  defName: Type.String({
    description: 'defName to fetch.',
  }),
  defType: Type.Optional(
    Type.String({
      description:
        'Optional defType filter. Set this if multiple def types share a defName.',
    }),
  ),
  merged: Type.Optional(
    Type.Boolean({
      description:
        'When true, walk the ParentName chain and merge inherited fields into the returned XML. Default false (returns the raw def as authored).',
    }),
  ),
});

interface DefRow {
  pack: string;
  defType: string;
  defName: string | null;
  inheritName: string | null;
  parentName: string | null;
  filePath: string;
  xml: string;
}

const NO_INDEX_MSG =
  'RimWorld source index is not built yet. Open Settings → RimWorld index → Rebuild.';

export const getDefDetailsTool: AgentTool<typeof Params, { defs: DefRow[] }> = {
  name: 'get_def_details',
  label: 'Get def details',
  description:
    'Return the full XML for one def (or every match if defName is ambiguous). Pass merged=true to fold ParentName inheritance into a single resolved XML — useful for ThingDef chains where most fields live on a shared abstract base.',
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<{ defs: DefRow[] }>> {
    const status = getIndexStatus();
    if (status.type === 'absent' || status.type === 'no-rimworld') {
      return {
        content: [{ type: 'text', text: NO_INDEX_MSG }],
        details: { defs: [] },
      };
    }
    const db = openIndexDb();
    const rawRows = (
      params.defType
        ? db.prepare(
            'SELECT pack, defType, defName, inheritName, parentName, filePath, xml FROM def WHERE defName = ? AND defType = ?',
          )
        : db.prepare(
            'SELECT pack, defType, defName, inheritName, parentName, filePath, xml FROM def WHERE defName = ?',
          )
    ).all(...(params.defType ? [params.defName, params.defType] : [params.defName])) as DefRow[];

    if (rawRows.length === 0) {
      return {
        content: [
          { type: 'text', text: `No def named "${params.defName}" found.` },
        ],
        details: { defs: [] },
      };
    }

    // DB stores `filePath` relative to the def-index root. Absolutize at the
    // tool boundary so the agent can pass paths straight to `read`.
    const { defsRoot } = getIndexPaths();
    const absolutize = (rel: string): string => path.resolve(defsRoot, rel);
    const rows: DefRow[] = rawRows.map((r) => ({
      ...r,
      filePath: absolutize(r.filePath),
    }));

    if (params.merged) {
      const merged = rows.map((r) => ({
        ...r,
        xml: mergeWithParents(db, r, absolutize),
      }));
      return {
        content: [{ type: 'text', text: renderRows(merged) }],
        details: { defs: merged },
      };
    }

    return {
      content: [{ type: 'text', text: renderRows(rows) }],
      details: { defs: rows },
    };
  },
};

function renderRows(rows: DefRow[]): string {
  if (rows.length === 1) {
    const r = rows[0];
    return `${r.pack} • ${r.defType} • ${r.defName ?? '(abstract)'}\n${r.filePath}\n\n${r.xml}`;
  }
  return rows
    .map(
      (r, i) =>
        `=== Match ${i + 1}: ${r.pack} • ${r.defType} • ${r.defName ?? '(abstract)'} ===\n${r.filePath}\n\n${r.xml}`,
    )
    .join('\n\n');
}

/**
 * Walk parentName up through abstract bases and string-merge the parent
 * blocks above the child block. We don't try to do a true semantic merge
 * (XML field union with override semantics) — that's surprisingly hard to
 * get right and the agent reads merged output as text anyway. The chain is
 * shown top-down so the agent sees Foo (abstract) → FooBase (abstract) →
 * MyFoo (concrete) in the order RimWorld resolves them.
 */
function mergeWithParents(
  db: ReturnType<typeof openIndexDb>,
  child: DefRow,
  absolutize: (rel: string) => string,
): string {
  const stmt = db.prepare(
    'SELECT pack, defType, defName, inheritName, parentName, filePath, xml FROM def WHERE inheritName = ? AND defType = ? LIMIT 1',
  );
  const chain: DefRow[] = [];
  let cur: DefRow | undefined = child;
  const seen = new Set<string>();
  while (cur && cur.parentName) {
    if (seen.has(cur.parentName)) break;
    seen.add(cur.parentName);
    const parent = stmt.get(cur.parentName, cur.defType) as DefRow | undefined;
    if (!parent) break;
    // Parent rows come straight from the DB with relative filePath; absolutize
    // so the inline (${p.filePath}) annotation matches the rest of the output.
    chain.push({ ...parent, filePath: absolutize(parent.filePath) });
    cur = parent;
  }
  if (chain.length === 0) return child.xml;
  return [
    ...chain
      .reverse()
      .map(
        (p) =>
          `<!-- inherited from ${p.inheritName ?? p.defName ?? '(unknown)'} (${p.filePath}) -->\n${p.xml}`,
      ),
    `<!-- child: ${child.defName ?? '(abstract)'} (${child.filePath}) -->\n${child.xml}`,
  ].join('\n\n');
}
