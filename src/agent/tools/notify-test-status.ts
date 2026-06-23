import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { sendToast, type ToastSeverity } from '../notifications.js';

const Params = Type.Object({
  summary: Type.String({
    description:
      'One short line shown over the game as a native OS toast. Keep it ~80 chars or less — the user is in the fullscreen game.',
  }),
  severity: Type.Union(
    [Type.Literal('info'), Type.Literal('warning'), Type.Literal('error')],
    {
      description:
        "'info' = unrelated/ignored (e.g. another mod's error). 'warning' = non-fatal in this mod (e.g. an unresolved reference or asset-load error worth investigating after the run) — test continues. 'error' = critical issue, fix needed before retesting.",
    },
  ),
});

export interface NotifyTestStatusDetails {
  summary: string;
  severity: ToastSeverity;
}

export const notifyTestStatusTool: AgentTool<
  typeof Params,
  NotifyTestStatusDetails
> = {
  name: 'notify_test_status',
  label: 'Notify test status',
  description:
    "Send a native OS toast (over the game) so the user knows what's happening without alt-tabbing to Modmixer. Use after triaging errors during a test session: 'info' for unrelated/ignored, 'warning' for non-fatal issues the test can continue past, 'error' for critical issues that need a fix. Keep the summary to one short line.",
  parameters: Params,
  async execute(
    _id,
    params,
  ): Promise<AgentToolResult<NotifyTestStatusDetails>> {
    const title =
      params.severity === 'error'
        ? 'Modmixer — Issue'
        : params.severity === 'warning'
          ? 'Modmixer — Heads up'
          : 'Modmixer';
    sendToast(title, params.summary);
    return {
      content: [
        {
          type: 'text',
          text: `Toast shown: "${params.summary}" (${params.severity})`,
        },
      ],
      details: { summary: params.summary, severity: params.severity },
    };
  },
};
