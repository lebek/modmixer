import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { openIndexDb } from '../index/db.js';
import { getIndexStatus } from '../index/rebuild.js';
import { getIndexPaths } from '../index/paths.js';

const Params = Type.Object({
  name: Type.String({
    description:
      'Symbol to read. Pass the short name ("StealAIUtility") to get all matches, the full FQN ("RimWorld.StealAIUtility.TryFindBestItemToSteal"), or a partial FQN ("LetterMaker.MakeLetter" — matches by suffix). All overloads of a method are returned — pick the one that matches your stack frame by signature.',
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

const NO_INDEX_MSG =
  'RimWorld source index is not built yet. Open Settings → RimWorld index → Rebuild.';

export const readCsharpSymbolTool: AgentTool<typeof Params, { hits: SymbolHit[] }> = {
  name: 'read_csharp_symbol',
  label: 'Read C# symbol',
  description:
    'Read the body of a C# type or member from the decompiled RimWorld source. Returns the symbol\'s text only — far smaller than read\'ing the whole file. Pass an FQN for a precise match, or a short name to see every match.',
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<{ hits: SymbolHit[] }>> {
    const status = getIndexStatus();
    if (status.type === 'absent' || status.type === 'no-rimworld') {
      return {
        content: [{ type: 'text', text: NO_INDEX_MSG }],
        details: { hits: [] },
      };
    }

    const db = openIndexDb();
    const cap = Math.min(Math.max(params.maxBytes ?? 4096, 256), 32768);

    // Resolve `name` against the index in three increasingly fuzzy passes:
    //   1. exact fqn match — for callers that already know the namespace
    //      ("Verse.LetterMaker.MakeLetter")
    //   2. fqn suffix match — for partial FQNs the agent typed off a stack
    //      frame ("LetterMaker.MakeLetter" → "Verse.LetterMaker.MakeLetter")
    //   3. shortName match — for bare member names ("MakeLetter")
    // Each pass returns ALL matches, so method overloads (same fqn, different
    // startLine — see csharp-indexer.ts) are surfaced together. We stop at the
    // first pass that yields any rows so a precise FQN doesn't get drowned in
    // unrelated short-name hits.
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
    let rows: Row[] = [];
    if (params.name.includes('.')) {
      rows = db
        .prepare(
          `${select} WHERE fqn = @name${kindClause} ${orderLimit}`,
        )
        .all({ name: params.name, ...kindArgs }) as Row[];
      if (rows.length === 0) {
        rows = db
          .prepare(
            `${select} WHERE fqn LIKE @suffix${kindClause} ${orderLimit}`,
          )
          .all({ suffix: `%.${params.name}`, ...kindArgs }) as Row[];
      }
    } else {
      rows = db
        .prepare(
          `${select} WHERE shortName = @name${kindClause} ${orderLimit}`,
        )
        .all({ name: params.name, ...kindArgs }) as Row[];
    }

    if (rows.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No C# symbol found matching "${params.name}"${params.kind ? ` (kind=${params.kind})` : ''}.`,
          },
        ],
        details: { hits: [] },
      };
    }

    const { sourceRoot } = getIndexPaths();
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
      // Surface the absolute path so the agent can `read` it for more context
      // without guessing where the index lives on disk.
      hits.push({ ...r, filePath: abs, body, truncated });
    }

    // When the query landed on multiple rows with the same FQN — i.e. method
    // overloads — prefix the response with a one-line index so the caller can
    // distinguish them by signature without a follow-up call. Plain
    // single-symbol hits (most reads) get no preamble.
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
