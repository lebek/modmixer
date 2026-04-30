import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { isRimWorldRunning } from '../game.js';

const Params = Type.Object({});

export const isRimWorldRunningTool: AgentTool<typeof Params, { running: boolean }> = {
  name: 'is_rimworld_running',
  label: 'Check if RimWorld is running',
  description:
    "Return true if RimWorld is currently running, false otherwise. Call this before asking the user — never ask 'is RimWorld open?' when you can check yourself. Useful before edits to ModsConfig.xml or before launch_rimworld (Steam's URL is a no-op on a running instance).",
  parameters: Params,
  async execute(): Promise<AgentToolResult<{ running: boolean }>> {
    const running = await isRimWorldRunning();
    return {
      content: [
        {
          type: 'text',
          text: running
            ? 'RimWorld is running.'
            : 'RimWorld is not running.',
        },
      ],
      details: { running },
    };
  },
};
