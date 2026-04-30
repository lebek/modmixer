import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import fsp from 'node:fs/promises';
import { detectRimWorldPaths } from '../paths.js';

const Params = Type.Object({
  lines: Type.Optional(
    Type.Number({
      description:
        'Maximum number of trailing lines to return after filtering. Default 200, max 2000.',
    }),
  ),
  pattern: Type.Optional(
    Type.String({
      description:
        'Case-insensitive substring to filter lines. If omitted, returns the raw tail.',
    }),
  ),
});

export interface TailPlayerLogDetails {
  logPath: string | null;
  totalLines: number;
  matched: number;
  returned: number;
}

export const tailPlayerLogTool: AgentTool<
  typeof Params,
  TailPlayerLogDetails
> = {
  name: 'tail_player_log',
  label: 'Tail Player.log',
  description:
    "Read trailing lines from RimWorld's Player.log to find runtime errors. Provide a pattern (e.g. an exception class or a mod name) to focus on the relevant lines. Player.log is rewritten on each game launch, so call after the user has reproduced the issue.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<TailPlayerLogDetails>> {
    const { playerLog } = detectRimWorldPaths();
    if (!playerLog) {
      return {
        content: [
          {
            type: 'text',
            text: 'Player.log not found. Has RimWorld been launched at least once on this machine?',
          },
        ],
        details: { logPath: null, totalLines: 0, matched: 0, returned: 0 },
      };
    }
    const max = Math.min(Math.max(params.lines ?? 200, 1), 2000);
    const text = await fsp.readFile(playerLog, 'utf8');
    const allLines = text.split(/\r?\n/);
    const filtered = params.pattern
      ? allLines.filter((l) =>
          l.toLowerCase().includes(params.pattern!.toLowerCase()),
        )
      : allLines;
    const tail = filtered.slice(-max);
    const header = `# ${playerLog}\n# total=${allLines.length}, matched=${filtered.length}, returned=${tail.length}${
      params.pattern ? `, pattern=${JSON.stringify(params.pattern)}` : ''
    }\n`;
    return {
      content: [{ type: 'text', text: header + tail.join('\n') }],
      details: {
        logPath: playerLog,
        totalLines: allLines.length,
        matched: filtered.length,
        returned: tail.length,
      },
    };
  },
};
