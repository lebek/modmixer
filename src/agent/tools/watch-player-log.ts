import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { getAgentHost } from '../agent-host.js';

const Params = Type.Object({});

export interface WatchPlayerLogDetails {
  monitoring: boolean;
}

export const watchPlayerLogTool: AgentTool<
  typeof Params,
  WatchPlayerLogDetails
> = {
  name: 'watch_player_log',
  label: 'Watch Player.log',
  description:
    "Start watching Player.log in the background. Returns IMMEDIATELY — no blocking. If new errors arrive during the user's test session, you will automatically be prompted with their content so you can investigate. Watching stops automatically when (a) errors arrive (one-shot), (b) RimWorld closes, or (c) the user switches to a different chat. Use this right after launch_rimworld; do NOT block in a long-running tool.",
  parameters: Params,
  async execute(): Promise<AgentToolResult<WatchPlayerLogDetails>> {
    const host = getAgentHost();
    const conversationId = host.getCurrentId();
    if (!conversationId) {
      throw new Error(
        'No active conversation. Cannot start log monitoring.',
      );
    }
    host.startLogMonitoring(conversationId);
    return {
      content: [
        {
          type: 'text',
          text: 'Watching Player.log in the background. I will pick up here automatically if any errors land while you test.',
        },
      ],
      details: { monitoring: true },
    };
  },
};
