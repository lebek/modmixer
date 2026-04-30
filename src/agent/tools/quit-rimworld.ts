import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { quitRimWorld, isRimWorldRunning } from '../game.js';

const Params = Type.Object({});

export const quitRimWorldTool: AgentTool<typeof Params, { wasRunning: boolean; killed: boolean }> = {
  name: 'quit_rimworld',
  label: 'Quit RimWorld',
  description:
    'Force-quit any running RimWorld process. Use ONLY after the user explicitly confirms — they may have unsaved progress. Useful when you need to edit ModsConfig.xml or do a clean re-launch and the user has agreed to drop the current game.',
  parameters: Params,
  async execute(): Promise<AgentToolResult<{ wasRunning: boolean; killed: boolean }>> {
    const wasRunning = await isRimWorldRunning();
    if (!wasRunning) {
      return {
        content: [{ type: 'text', text: 'RimWorld is not running.' }],
        details: { wasRunning: false, killed: false },
      };
    }
    const { killed } = await quitRimWorld();
    return {
      content: [
        {
          type: 'text',
          text: killed
            ? 'Sent quit signal to RimWorld. Wait a moment before re-launching.'
            : 'Failed to quit RimWorld — try quitting manually.',
        },
      ],
      details: { wasRunning: true, killed },
    };
  },
};
