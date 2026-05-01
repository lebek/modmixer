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
      'Symbol to read. Pass the short name ("StealAIUtility") to get all matches, or the FQN ("RimWorld.StealAIUtility.TryFindBestItemToSteal") to pinpoint one. Works for class/struct/interface/enum/record/method/constructor/property/field/event symbols.',
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

    // Decide whether `name` is an FQN (contains dots) or a short name.
    const isFqn = params.name.includes('.');
    const where: string[] = [];
    const args: Record<string, unknown> = {};
    if (isFqn) {
      where.push('fqn = @name');
      args.name = params.name;
    } else {
      where.push('shortName = @name');
      args.name = params.name;
    }
    if (params.kind) {
      where.push('kind = @kind');
      args.kind = params.kind;
    }
    const sql = `
      SELECT fqn, shortName, kind, parentFqn, filePath, startLine, endLine, signature
      FROM symbol
      WHERE ${where.join(' AND ')}
      ORDER BY length(fqn), fqn
      LIMIT 25
    `;
    const rows = db.prepare(sql).all(args) as Omit<SymbolHit, 'body' | 'truncated'>[];

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
      const abs = path.join(sourceRoot, r.filePath);
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
      hits.push({ ...r, body, truncated });
    }

    const text = hits
      .map(
        (h) =>
          `=== ${h.kind} ${h.fqn} (${h.filePath}:${h.startLine}-${h.endLine}) ===\n${h.body}`,
      )
      .join('\n\n');
    return {
      content: [{ type: 'text', text }],
      details: { hits },
    };
  },
};
