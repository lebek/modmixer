import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import path from 'node:path';
import { openIndexDb } from '../index/db.js';
import { getIndexPaths } from '../index/paths.js';
import { getIndexStatus } from '../index/rebuild.js';

const Params = Type.Object({
  defName: Type.String({
    description: 'The defName to look up references for (e.g. "Steel", "BaseHumanGun").',
  }),
  limit: Type.Optional(
    Type.Number({ description: 'Max rows (default 50, max 500).' }),
  ),
});

interface RefHit {
  filePath: string;
  line: number;
}

const NO_INDEX_MSG =
  'RimWorld source index is not built yet (or built without C# decompile). Open Settings → RimWorld index → Rebuild.';

export const whoUsesDefTool: AgentTool<typeof Params, { hits: RefHit[] }> = {
  name: 'who_uses_def',
  label: 'Find def references in code',
  description:
    'Find every C# location where a def is referenced by name (string literal). Bridges the def index and the source index — answers "what code reads this def?" without manually grepping.',
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<{ hits: RefHit[] }>> {
    const status = getIndexStatus();
    if (status.type === 'absent' || status.type === 'no-rimworld') {
      return {
        content: [{ type: 'text', text: NO_INDEX_MSG }],
        details: { hits: [] },
      };
    }
    const db = openIndexDb();
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
    const rawRows = db
      .prepare(
        'SELECT filePath, line FROM def_reference WHERE defName = ? ORDER BY filePath, line LIMIT ?',
      )
      .all(params.defName, limit) as RefHit[];

    if (rawRows.length === 0) {
      return {
        content: [
          { type: 'text', text: `No C# references to "${params.defName}".` },
        ],
        details: { hits: [] },
      };
    }
    // DB stores `filePath` relative to the source-index root. Surface it
    // absolute so the agent can pass it straight to `read`.
    const { sourceRoot } = getIndexPaths();
    const rows: RefHit[] = rawRows.map((r) => ({
      ...r,
      filePath: path.resolve(sourceRoot, r.filePath),
    }));
    const lines = rows.map((r) => `${r.filePath}:${r.line}`);
    return {
      content: [
        {
          type: 'text',
          text: `Found ${rows.length} reference${rows.length === 1 ? '' : 's'} to "${params.defName}":\n\n${lines.join('\n')}`,
        },
      ],
      details: { hits: rows },
    };
  },
};
