// Drill-in tool for the bridge-driven diagnostics flow. The agent receives
// a deduped error summary as an auto-prompt; each row carries a `[#hash]`
// tag. Passing the hash here returns the full text (message + stack trace)
// from the most recent occurrence of that error class, plus attribution
// and counts. Replaces tail_player_log for the test-monitoring loop —
// Player.log parsing is no longer the source of truth.

import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { getMonitorServer } from '../monitor/server.js';

const Params = Type.Object({
  hash: Type.String({
    description:
      'The `[#xxxxxxxx]` hash from a [automated …] auto-prompt summary row. Identifies one error class (one stack-signature) for drill-in.',
  }),
});

export interface MonitorGetErrorDetails {
  hash: string;
  found: boolean;
  severity: string | null;
  count: number;
  attributedMods: string[];
  firstAt: number | null;
  lastAt: number | null;
}

export const monitorGetErrorTool: AgentTool<
  typeof Params,
  MonitorGetErrorDetails
> = {
  name: 'monitor_get_error',
  label: 'Get full error from bridge',
  description:
    "Drill into one error class from the most recent [automated …] auto-prompt. The summary's `[#xxxxxxxx]` hash uniquely identifies an error by its stack signature; passing it here returns the full text (message + stack trace) from the latest occurrence, plus severity, attributed mods, and occurrence count. Always drill into the highest-count row first — the cascade pattern usually points at the root cause more clearly than the message header. The bridge retains the last ~200 distinct errors per game session; older entries fall out and become unrecoverable.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<MonitorGetErrorDetails>> {
    const hash = params.hash.trim().replace(/^\[?#/, '').replace(/\]$/, '');
    const bucket = getMonitorServer().getErrorByHash(hash);
    if (!bucket) {
      return {
        content: [
          {
            type: 'text',
            text:
              `No error with hash ${hash} retained by the bridge. ` +
              `Either the game session has ended (the buffer is cleared on disconnect), ` +
              `or this error class has been evicted by newer ones (~200 cap). ` +
              `If a test session is in progress, ask the user to reproduce.`,
          },
        ],
        details: {
          hash,
          found: false,
          severity: null,
          count: 0,
          attributedMods: [],
          firstAt: null,
          lastAt: null,
        },
      };
    }
    const header =
      `# severity=${bucket.severity} count=${bucket.count} ` +
      `attributed=${bucket.attributedMods.join(', ') || 'Unknown'} ` +
      `hash=${bucket.hash}\n`;
    return {
      content: [{ type: 'text', text: header + bucket.text }],
      details: {
        hash: bucket.hash,
        found: true,
        severity: bucket.severity,
        count: bucket.count,
        attributedMods: bucket.attributedMods,
        firstAt: bucket.firstAt,
        lastAt: bucket.lastAt,
      },
    };
  },
};
