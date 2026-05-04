import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { openIndexDb } from '../index/db.js';
import { getIndexStatus } from '../index/rebuild.js';

const Params = Type.Object({
  query: Type.String({
    description:
      'Search term. Matched against defName (substring), label, and description (FTS). Empty string returns the first results filtered only by defType/pack.',
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
});

interface SearchDefsHit {
  pack: string;
  defType: string;
  defName: string | null;
  label: string;
  filePath: string;
}

const NO_INDEX_MSG =
  'RimWorld source index is not built yet. Open Settings → RimWorld index → Rebuild, or wait for the startup index to finish.';

export const searchDefsTool: AgentTool<typeof Params, { hits: SearchDefsHit[] }> = {
  name: 'search_defs',
  label: 'Search defs',
  description:
    "Search the RimWorld def index by defName, label, or description. Returns small summaries (defName/defType/file/pack). Pair with get_def_details to read the full XML for a hit. Indexes Core + the user's DLCs. Always reach for this BEFORE shelling out to `bash strings ... | grep` against the game's DLLs or XML — the index is faster and structured.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<{ hits: SearchDefsHit[] }>> {
    const status = getIndexStatus();
    if (status.type === 'absent' || status.type === 'no-rimworld') {
      return {
        content: [{ type: 'text', text: NO_INDEX_MSG }],
        details: { hits: [] },
      };
    }
    const db = openIndexDb();
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
      // Two-pass: defName substring (cheap) ∪ FTS hits, deduped, ordered.
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
      return {
        content: [
          { type: 'text', text: `No defs matched "${q}"${params.defType ? ` (defType=${params.defType})` : ''}${params.pack ? ` (pack=${params.pack})` : ''}.` },
        ],
        details: { hits: [] },
      };
    }
    const lines = rows.map(
      (r) =>
        `${r.pack} • ${r.defType} • ${r.defName ?? '(abstract)'}${r.label ? ` — ${r.label}` : ''}\n    ${r.filePath}`,
    );
    return {
      content: [
        {
          type: 'text',
          text:
            `Found ${rows.length} def${rows.length === 1 ? '' : 's'}.\n\n` +
            lines.join('\n'),
        },
      ],
      details: { hits: rows },
    };
  },
};

/**
 * Escape FTS5 metacharacters and wrap multi-word queries in a phrase. Without
 * this, a query containing "-" or special glyphs raises a syntax error from
 * the FTS5 parser.
 */
function ftsEscape(q: string): string {
  // Strip double quotes and wrap as a quoted phrase so dashes/punctuation
  // don't get treated as FTS operators.
  return `"${q.replace(/"/g, '')}"`;
}
