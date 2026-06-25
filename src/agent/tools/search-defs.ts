import { Type } from 'typebox';
import type { TObject } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import path from 'node:path';
import { openIndexDb } from '../index/db.js';
import { getIndexPaths } from '../index/paths.js';
import type { GameId } from '../games/types.js';

// Type anchor only. The actual schema is supplied per-game via spec.params with
// corpus-specific docs (RimWorld XML defs vs Minecraft data JSON); the SHAPE is
// identical across games, so this keeps `typeof Params` a stable type anchor.
const Params = Type.Object({
  query: Type.String(),
  defType: Type.Optional(Type.String()),
  pack: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number()),
  merged: Type.Optional(Type.Boolean()),
  descendantsOf: Type.Optional(Type.String()),
  recursive: Type.Optional(Type.Boolean()),
  referencedBy: Type.Optional(Type.String()),
});

/**
 * Per-game presentation for search_defs. The SQL mechanism below is shared; the
 * game's adapter supplies the corpus-specific label, docs, schema, and the
 * "index not ready" check. Lives in `<game>/research-tools.ts`.
 */
export interface SearchDefsSpec {
  label: string;
  description: string;
  /** Typebox schema with corpus-specific param docs (same shape as Params). */
  params: TObject;
  /** Game-specific readiness check; returns a user-facing message or null. */
  notReady(): string | null;
}

interface SearchDefsHit {
  pack: string;
  defType: string;
  defName: string | null;
  inheritName: string | null;
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

export function createSearchDefsTool(
  game: GameId,
  spec: SearchDefsSpec,
): AgentTool<typeof Params, Details> {
  return {
  name: 'search_defs',
  label: spec.label,
  description: spec.description,
  parameters: spec.params as typeof Params,
  async execute(_id, params): Promise<AgentToolResult<Details>> {
    const notReady = spec.notReady();
    if (notReady) {
      return {
        content: [{ type: 'text', text: notReady }],
        details: { mode: 'search', hits: [] },
      };
    }
    const db = openIndexDb(game);
    const { defsRoot, sourceRoot } = getIndexPaths(game);

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
        SELECT pack, defType, defName, inheritName, label, filePath
        FROM def
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY pack, defType, COALESCE(defName, inheritName)
        LIMIT @limit
      `;
      rows = db.prepare(sql).all(args) as SearchDefsHit[];
    } else {
      // Split on whitespace and AND the terms. Single-word queries are a
      // single-term AND (no behavior change). Multi-word queries used to be
      // phrase-quoted ("FactionDef Pirate") and almost always 0-hit.
      const allTerms = q.split(/\s+/).filter(Boolean);
      let terms = allTerms;
      // If the first term duplicates the defType filter (e.g. query
      // "FactionDef Pirate" with defType=FactionDef), drop it.
      if (
        params.defType &&
        terms.length > 1 &&
        terms[0].toLowerCase() === params.defType.toLowerCase()
      ) {
        terms = terms.slice(1);
      }

      const runQuery = (queryTerms: string[]): SearchDefsHit[] => {
        const ftsTerm = queryTerms
          .map((t) => `"${t.replace(/"/g, '')}"`)
          .join(' AND ');
        const sqlFts = `
          SELECT def.pack, def.defType, def.defName, def.inheritName, def.label, def.filePath
          FROM def_fts
          JOIN def ON def.id = def_fts.rowid
          WHERE def_fts MATCH @fts
          ${where.length ? 'AND ' + where.join(' AND ') : ''}
          LIMIT @limit
        `;
        const likeArgs: Record<string, unknown> = { ...args };
        const likeConds: string[] = [];
        queryTerms.forEach((t, i) => {
          const key = `t${i}`;
          likeConds.push(`(defName LIKE @${key} OR inheritName LIKE @${key})`);
          likeArgs[key] = `%${t}%`;
        });
        const sqlLike = `
          SELECT pack, defType, defName, inheritName, label, filePath
          FROM def
          WHERE ${likeConds.join(' AND ')}
          ${where.length ? 'AND ' + where.join(' AND ') : ''}
          ORDER BY length(COALESCE(defName, inheritName)), COALESCE(defName, inheritName)
          LIMIT @limit
        `;
        const ftsHits = db
          .prepare(sqlFts)
          .all({ ...args, fts: ftsTerm }) as SearchDefsHit[];
        const likeHits = db.prepare(sqlLike).all(likeArgs) as SearchDefsHit[];
        const seen = new Set<string>();
        const merged: SearchDefsHit[] = [];
        for (const r of [...likeHits, ...ftsHits]) {
          const key = `${r.pack}|${r.defType}|${r.defName ?? r.inheritName ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(r);
          if (merged.length >= limit) break;
        }
        return merged;
      };

      rows = runQuery(terms);
      // Fallback: when the AND'd query misses, try the last term alone — it's
      // usually the actual name, and the leading words are class/category hints
      // the FTS index doesn't carry (e.g. "IncidentWorker RaidEnemy" → "RaidEnemy").
      if (rows.length === 0 && terms.length > 1) {
        rows = runQuery([terms[terms.length - 1]]);
      }
    }

    if (rows.length === 0) {
      const filterNote = [
        params.defType ? `defType=${params.defType}` : null,
        params.pack ? `pack=${params.pack}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      const tips = [
        "Tips: this index covers XML defs only. If you're looking for code behavior or an API pattern, try search_source or read_symbol.",
      ];
      const dlcHint = missingDlcHint(db, q);
      if (dlcHint) tips.push(dlcHint);
      return {
        content: [
          {
            type: 'text',
            text:
              `No defs matched "${q}"${filterNote ? ` (${filterNote})` : ''}.\n` +
              tips.join(' '),
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
      const only = absRows[0];
      const expandedRow = fetchDefRow(
        db,
        only.defName,
        only.inheritName,
        only.defType,
        defsRoot,
      );
      if (expandedRow) {
        const xml = wantMerged
          ? mergeWithParents(db, expandedRow, defsRoot)
          : expandedRow.xml;
        const label = formatDefIdentity(expandedRow);
        return {
          content: [
            {
              type: 'text',
              text:
                `Found 1 def.\n${expandedRow.pack} • ${expandedRow.defType} • ${label}\n${expandedRow.filePath}\n\n${xml}`,
            },
          ],
          details: { mode: 'search', hits: absRows, expanded: { ...expandedRow, xml } },
        };
      }
    }

    const lines = absRows.map(
      (r) =>
        `${r.pack} • ${r.defType} • ${formatDefIdentity(r)}${r.label ? ` — ${r.label}` : ''}\n    ${r.filePath}`,
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
}

function fetchDefRow(
  db: ReturnType<typeof openIndexDb>,
  defName: string | null,
  inheritName: string | null,
  defType: string,
  defsRoot: string,
): DefRow | null {
  // Abstract defs have defName=null; identity lives in inheritName (the
  // value of the XML's Name="…" attribute). Look them up that way.
  const row = defName
    ? db
        .prepare(
          'SELECT pack, defType, defName, inheritName, parentName, filePath, xml FROM def WHERE defName = ? AND defType = ?',
        )
        .get(defName, defType)
    : inheritName
      ? db
          .prepare(
            'SELECT pack, defType, defName, inheritName, parentName, filePath, xml FROM def WHERE inheritName = ? AND defType = ? AND defName IS NULL',
          )
          .get(inheritName, defType)
      : null;
  if (!row) return null;
  const r = row as DefRow;
  return { ...r, filePath: path.resolve(defsRoot, r.filePath) };
}

function formatDefIdentity(r: { defName: string | null; inheritName: string | null }): string {
  if (r.defName) return r.defName;
  if (r.inheritName) return `${r.inheritName} (abstract)`;
  return '(abstract)';
}

// Known content of DLC packs the user might not own. Keyed by pack name as
// stored in the `def` table (matches RimWorld Data/<pack>/ folder names). The
// substrings are short, distinctive defNames or terminology — case-insensitive
// substring match against the query. If the query mentions one and the DLC
// isn't indexed, point that out so the agent stops hunting for content that
// can't exist in this installation.
const DLC_HINT_TOKENS: Record<string, string[]> = {
  Anomaly: [
    'shambler',
    'sightstealer',
    'gorehulk',
    'metalhorror',
    'fleshbeast',
    'devourer',
    'noctol',
    'chimera',
    'monolith',
    'voidnode',
    'unnatural',
    'entities',
  ],
  Royalty: ['psylink', 'neuroformer', 'bestowing', 'empire', 'royaltitle'],
  Ideology: ['precept', 'memedef', 'ideodef', 'ritualoutcome'],
  Biotech: ['xenotype', 'mechanitor', 'genepack', 'growthtier'],
};

function missingDlcHint(
  db: ReturnType<typeof openIndexDb>,
  query: string,
): string | null {
  const q = query.toLowerCase();
  for (const [pack, tokens] of Object.entries(DLC_HINT_TOKENS)) {
    if (!tokens.some((t) => q.includes(t))) continue;
    const row = db
      .prepare('SELECT 1 AS hit FROM def WHERE pack = ? LIMIT 1')
      .get(pack) as { hit: number } | undefined;
    if (!row) {
      return `The ${pack} DLC isn't in this index — that content can't be found here even if it exists in vanilla.`;
    }
  }
  return null;
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

