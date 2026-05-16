// Pull tool for the run-scoped bridge diagnostics flow. The error monitor is
// edge-triggered: each error class is auto-prompted exactly once per run, so
// recurrences never re-prompt. This tool is how the agent gets *current*
// state on demand — updated occurrence counts, and any classes that appeared
// after the last auto-prompt. Errors are scoped to the current test run
// (one run_test_cycle launch); this lists that run's classes only.

import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { getMonitorServer } from '../monitor/server.js';

const Params = Type.Object({});

export interface MonitorPollRow {
  hash: string;
  severity: string;
  count: number;
  attributedMods: string[];
  firstLine: string;
}

export interface MonitorPollDetails {
  /** Id of the current test run. 0 if no game has connected yet. */
  runId: number;
  /** Whether a game is connected to the bridge right now. */
  connected: boolean;
  /** Every error class retained for the current run, count-descending. */
  errors: MonitorPollRow[];
}

const MAX_LINE = 240;

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= MAX_LINE ? flat : flat.slice(0, MAX_LINE - 1) + '…';
}

export const monitorPollTool: AgentTool<typeof Params, MonitorPollDetails> = {
  name: 'monitor_poll',
  label: 'Poll bridge error state',
  description:
    "List every error class the bridge has captured for the current test run, with live occurrence counts. The error monitor is edge-triggered — each class is auto-prompted only once per run, and recurrences are silent — so this is how you get an updated `×count` after a class was first reported, or discover classes that appeared since the last auto-prompt. Each row matches the auto-prompt format (×count, severity, attribution, `[#hash]`); drill into any row with monitor_get_error. Run-scoped: a new run_test_cycle launch starts a fresh run with an empty error set.",
  parameters: Params,
  async execute(): Promise<AgentToolResult<MonitorPollDetails>> {
    const server = getMonitorServer();
    const runId = server.getRunId();
    const connected = server.getState().kind === 'connected';
    const buckets = server.getErrorBuckets();
    // getErrorBuckets sorts most-recent-first; the agent triages by count.
    buckets.sort((a, b) => b.count - a.count || a.firstAt - b.firstAt);

    const errors: MonitorPollRow[] = buckets.map((b) => ({
      hash: b.hash,
      severity: b.severity,
      count: b.count,
      attributedMods: b.attributedMods,
      firstLine: b.firstLine,
    }));

    const connLine = connected
      ? 'game connected'
      : 'no game connected (last known state below)';

    let text: string;
    if (errors.length === 0) {
      text = `# test run #${runId} — ${connLine}\nNo errors captured in this run.`;
    } else {
      const rows = errors.map((e) => {
        const mods = `[${e.attributedMods.join(', ') || 'Unknown'}]`;
        return `×${e.count}  ${e.severity}  ${mods}  [#${e.hash}]  ${truncate(e.firstLine)}`;
      });
      text = [
        `# test run #${runId} — ${connLine} — ${errors.length} error ${errors.length === 1 ? 'class' : 'classes'}`,
        '',
        ...rows,
      ].join('\n');
    }

    return {
      content: [{ type: 'text', text }],
      details: { runId, connected, errors },
    };
  },
};
