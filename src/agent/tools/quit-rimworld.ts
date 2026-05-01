import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { quitRimWorld, isRimWorldRunning } from '../game.js';

const Params = Type.Object({});

interface QuitDetails {
  wasRunning: boolean;
  killed: boolean;
  exited: boolean;
}

export const quitRimWorldTool: AgentTool<typeof Params, QuitDetails> = {
  name: 'quit_rimworld',
  label: 'Quit RimWorld',
  description:
    "Force-quit any running RimWorld process and wait until the OS has reaped it. Use ONLY after the user explicitly confirms — they may have unsaved progress. Returns once RimWorld is actually gone, so it is safe to call enable_mod_in_game or launch_rimworld immediately afterwards without sleeping.",
  parameters: Params,
  async execute(): Promise<AgentToolResult<QuitDetails>> {
    const wasRunning = await isRimWorldRunning();
    if (!wasRunning) {
      return {
        content: [{ type: 'text', text: 'RimWorld is not running.' }],
        details: { wasRunning: false, killed: false, exited: true },
      };
    }
    const { killed, exited } = await quitRimWorld();
    let text: string;
    if (!killed) {
      text = 'Failed to quit RimWorld — try quitting manually.';
    } else if (!exited) {
      text =
        'Sent quit signal but RimWorld is still showing as running after 10 seconds. It may exit shortly; check is_rimworld_running before re-launching.';
    } else {
      text = 'RimWorld has exited. Safe to re-launch immediately.';
    }
    return {
      content: [{ type: 'text', text }],
      details: { wasRunning: true, killed, exited },
    };
  },
};
