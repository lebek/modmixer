// Drill-in tool for the bridge-driven diagnostics flow. The agent receives
// a deduped error summary as an auto-prompt; each row carries a `[#hash]`
// tag. Passing the hash here returns the full text (message + stack trace)
// from the most recent occurrence of that error class, plus attribution
// and counts. Replaces tail_player_log for the test-monitoring loop —
// Player.log parsing is no longer the source of truth.

import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
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
  /** Id of the current test run — the run the error buckets belong to. */
  runId: number;
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
    "Drill into one error class from an [automated …] auto-prompt. The summary's `[#xxxxxxxx]` hash uniquely identifies an error by its stack signature; passing it here returns the full text (message + stack trace) from the latest occurrence, plus severity, attributed mods, and occurrence count. Always drill into the highest-count row first — the cascade pattern usually points at the root cause more clearly than the message header. Errors are scoped to the current test run; this resolves hashes from the current run only. A hash from an earlier run (each run_test_cycle launch starts a new run) won't be found — that's expected. Use monitor_poll to list every error class in the current run.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<MonitorGetErrorDetails>> {
    const hash = params.hash.trim().replace(/^\[?#/, '').replace(/\]$/, '');
    const server = getMonitorServer();
    const runId = server.getRunId();
    const bucket = server.getErrorByHash(hash);
    if (!bucket) {
      const connected = server.getState().kind === 'connected';
      return {
        content: [
          {
            type: 'text',
            text:
              `No error class with hash ${hash} in test run #${runId}. ` +
              `Errors are run-scoped: if this hash came from an auto-prompt ` +
              `for an earlier run, it's expected to be gone — your fix+relaunch ` +
              `started a fresh run. ` +
              (connected
                ? `Call monitor_poll to see every error class in run #${runId}.`
                : `No game is currently connected; the buckets above are run #${runId}'s last state.`),
          },
        ],
        details: {
          hash,
          found: false,
          runId,
          severity: null,
          count: 0,
          attributedMods: [],
          firstAt: null,
          lastAt: null,
        },
      };
    }
    const header =
      `# run=#${runId} severity=${bucket.severity} count=${bucket.count} ` +
      `attributed=${bucket.attributedMods.join(', ') || 'Unknown'} ` +
      `hash=${bucket.hash}\n`;
    return {
      content: [{ type: 'text', text: header + bucket.text }],
      details: {
        hash: bucket.hash,
        found: true,
        runId,
        severity: bucket.severity,
        count: bucket.count,
        attributedMods: bucket.attributedMods,
        firstAt: bucket.firstAt,
        lastAt: bucket.lastAt,
      },
    };
  },
};
