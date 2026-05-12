import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import path from 'node:path';
import { openIndexDb } from '../index/db.js';
import { getIndexPaths } from '../index/paths.js';
import { getIndexStatus } from '../index/rebuild.js';

const Params = Type.Object({
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
});

interface SearchDefsHit {
  pack: string;
  defType: string;
  defName: string | null;
  label: string;
  filePath: string;
}

interface DefRow {
  pack: string;
  defType: string;
  defName: string | null;
  inheritName: string | null;
  parentName: string | null;
  filePath: string;
  xml: string;
}

interface DescendantHit {
  pack: string;
  defType: string;
  defName: string | null;
  inheritName: string | null;
  filePath: string;
  depth: number;
}

interface RefHit {
  filePath: string;
  line: number;
}

type Details =
  | { mode: 'search'; hits: SearchDefsHit[]; expanded?: DefRow }
  | { mode: 'descendants'; hits: DescendantHit[] }
  | { mode: 'references'; hits: RefHit[] };

const NO_INDEX_MSG =
  'RimWorld source index is not built yet. Open Settings → RimWorld index → Rebuild, or wait for the startup index to finish.';

export const searchDefsTool: AgentTool<typeof Params, Details> = {
  name: 'search_defs',
  label: 'Search defs',
  description:
    "Look up XML defs in the indexed Core + DLCs corpus. Three modes in one tool:\n\n• default — search by defName / label / description. When exactly one def matches, the full merged XML is returned inline (saves a follow-up call). When multiple match, returns summaries.\n• descendantsOf=<Name> — find every def that extends a parent via ParentName (e.g. \"BaseFilth\"). Pass recursive=true to walk transitively.\n• referencedBy=<defName> — find every C# source location that mentions this defName by string literal.\n\nThis tells you what XML data exists. For code BEHAVIOR (how does X work, why isn't Y firing, what's the right API pattern) start with search_source or read_csharp_symbol — the def database can't tell you how the engine consumes a def. Zero results here doesn't mean nothing exists; it usually means the answer lives in C# source, not XML.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<Details>> {
    const status = getIndexStatus();
    if (status.type === 'absent' || status.type === 'no-rimworld') {
      return {
        content: [{ type: 'text', text: NO_INDEX_MSG }],
        details: { mode: 'search', hits: [] },
      };
    }
    const db = openIndexDb();
    const { defsRoot, sourceRoot } = getIndexPaths();

    if (params.descendantsOf) {
      return runDescendants(db, params, defsRoot);
    }
    if (params.referencedBy) {
      return runReferences(db, params, sourceRoot);
    }

    const limit = Math.min(Math.max(params.limit ?? 25, 1), 200);
    const where: string[] = [];
    const args: Record<string, unknown> = { limit };
    if (params.defType) {
      where.push('def.defType = @defType');
      args.defType = params.defType;
    }
    if (params.pack) {
      where.push('def.pack = @pack');
      args.pack = params.pack;
    }

    const q = params.query.trim();
    let rows: SearchDefsHit[];
    if (q.length === 0) {
      const sql = `
        SELECT pack, defType, defName, label, filePath
        FROM def
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY pack, defType, defName
        LIMIT @limit
      `;
      rows = db.prepare(sql).all(args) as SearchDefsHit[];
    } else {
      const ftsTerm = ftsEscape(q);
      const sqlFts = `
        SELECT def.pack, def.defType, def.defName, def.label, def.filePath
        FROM def_fts
        JOIN def ON def.id = def_fts.rowid
        WHERE def_fts MATCH @fts
        ${where.length ? 'AND ' + where.join(' AND ') : ''}
        LIMIT @limit
      `;
      const sqlLike = `
        SELECT pack, defType, defName, label, filePath
        FROM def
        WHERE defName LIKE @like
        ${where.length ? 'AND ' + where.join(' AND ') : ''}
        ORDER BY length(defName), defName
        LIMIT @limit
      `;
      const ftsHits = db
        .prepare(sqlFts)
        .all({ ...args, fts: ftsTerm }) as SearchDefsHit[];
      const likeHits = db
        .prepare(sqlLike)
        .all({ ...args, like: `%${q}%` }) as SearchDefsHit[];
      const seen = new Set<string>();
      rows = [];
      for (const r of [...likeHits, ...ftsHits]) {
        const key = `${r.pack}|${r.defType}|${r.defName ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(r);
        if (rows.length >= limit) break;
      }
    }

    if (rows.length === 0) {
      const filterNote = [
        params.defType ? `defType=${params.defType}` : null,
        params.pack ? `pack=${params.pack}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      return {
        content: [
          {
            type: 'text',
            text:
              `No defs matched "${q}"${filterNote ? ` (${filterNote})` : ''}.\n` +
              'Tips: this index covers XML defs only. If you\'re looking for code behavior or an API pattern, try search_source or read_csharp_symbol.',
          },
        ],
        details: { mode: 'search', hits: [] },
      };
    }

    const absRows: SearchDefsHit[] = rows.map((r) => ({
      ...r,
      filePath: path.resolve(defsRoot, r.filePath),
    }));

    // Single-hit expansion: when the query landed on exactly one def AND the
    // caller asked for it (default true), fetch the full XML inline. Saves
    // the search_defs → get_def_details chain that was the most common
    // two-call pattern pre-merge.
    const wantMerged = params.merged !== false;
    if (absRows.length === 1) {
      const expandedRow = fetchDefRow(db, absRows[0].defName, absRows[0].defType, defsRoot);
      if (expandedRow) {
        const xml = wantMerged
          ? mergeWithParents(db, expandedRow, defsRoot)
          : expandedRow.xml;
        return {
          content: [
            {
              type: 'text',
              text:
                `Found 1 def.\n${expandedRow.pack} • ${expandedRow.defType} • ${expandedRow.defName ?? '(abstract)'}\n${expandedRow.filePath}\n\n${xml}`,
            },
          ],
          details: { mode: 'search', hits: absRows, expanded: { ...expandedRow, xml } },
        };
      }
    }

    const lines = absRows.map(
      (r) =>
        `${r.pack} • ${r.defType} • ${r.defName ?? '(abstract)'}${r.label ? ` — ${r.label}` : ''}\n    ${r.filePath}`,
    );
    return {
      content: [
        {
          type: 'text',
          text:
            `Found ${absRows.length} def${absRows.length === 1 ? '' : 's'}.\n\n` +
            lines.join('\n'),
        },
      ],
      details: { mode: 'search', hits: absRows },
    };
  },
};

function fetchDefRow(
  db: ReturnType<typeof openIndexDb>,
  defName: string | null,
  defType: string,
  defsRoot: string,
): DefRow | null {
  if (!defName) return null;
  const row = db
    .prepare(
      'SELECT pack, defType, defName, inheritName, parentName, filePath, xml FROM def WHERE defName = ? AND defType = ?',
    )
    .get(defName, defType) as DefRow | undefined;
  if (!row) return null;
  return { ...row, filePath: path.resolve(defsRoot, row.filePath) };
}

function mergeWithParents(
  db: ReturnType<typeof openIndexDb>,
  child: DefRow,
  defsRoot: string,
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
    chain.push({ ...parent, filePath: path.resolve(defsRoot, parent.filePath) });
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

function runDescendants(
  db: ReturnType<typeof openIndexDb>,
  params: { descendantsOf?: string; defType?: string; recursive?: boolean; limit?: number },
  defsRoot: string,
): AgentToolResult<Details> {
  const parent = params.descendantsOf!;
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
  const queue: { parent: string; depth: number }[] = [{ parent, depth: 0 }];
  const hits: DescendantHit[] = [];
  while (queue.length > 0 && hits.length < limit) {
    const { parent: p, depth } = queue.shift()!;
    const rows = (
      params.defType ? stmt.all(p, params.defType) : stmt.all(p)
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
      content: [{ type: 'text', text: `No defs extend "${parent}".` }],
      details: { mode: 'descendants', hits: [] },
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
          `Found ${hits.length} descendant${hits.length === 1 ? '' : 's'} of ${parent}.\n\n` +
          lines.join('\n'),
      },
    ],
    details: { mode: 'descendants', hits },
  };
}

function runReferences(
  db: ReturnType<typeof openIndexDb>,
  params: { referencedBy?: string; limit?: number },
  sourceRoot: string,
): AgentToolResult<Details> {
  const defName = params.referencedBy!;
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
  const rawRows = db
    .prepare(
      'SELECT filePath, line FROM def_reference WHERE defName = ? ORDER BY filePath, line LIMIT ?',
    )
    .all(defName, limit) as RefHit[];
  if (rawRows.length === 0) {
    return {
      content: [
        { type: 'text', text: `No C# references to "${defName}".` },
      ],
      details: { mode: 'references', hits: [] },
    };
  }
  const rows: RefHit[] = rawRows.map((r) => ({
    ...r,
    filePath: path.resolve(sourceRoot, r.filePath),
  }));
  const lines = rows.map((r) => `${r.filePath}:${r.line}`);
  return {
    content: [
      {
        type: 'text',
        text: `Found ${rows.length} reference${rows.length === 1 ? '' : 's'} to "${defName}":\n\n${lines.join('\n')}`,
      },
    ],
    details: { mode: 'references', hits: rows },
  };
}

function ftsEscape(q: string): string {
  return `"${q.replace(/"/g, '')}"`;
}
