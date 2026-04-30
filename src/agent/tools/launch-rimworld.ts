import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { launchRimWorldViaSteam, type LaunchResult } from '../game.js';

const Params = Type.Object({});

export const launchRimWorldTool: AgentTool<typeof Params, LaunchResult> = {
  name: 'launch_rimworld',
  label: 'Launch RimWorld',
  description:
    'Start RimWorld via Steam (cold launch). If RimWorld is already running, this is a no-op (the Steam URL only focuses an existing instance and does NOT reload mods). Run sync_to_game and enable_mod_in_game first when testing a workspace mod. After launch, tell the user the specific in-game action that exercises the change.',
  parameters: Params,
  async execute(): Promise<AgentToolResult<LaunchResult>> {
    const result = await launchRimWorldViaSteam();
    const text = result.alreadyRunning
      ? 'RimWorld is already running — Steam launch is a no-op (does not reload mods). Ask the user to quit RimWorld and retry, or use the quit_rimworld tool if they confirm.'
      : `Launched RimWorld via Steam (${result.url}). The game window should appear shortly.`;
    return { content: [{ type: 'text', text }], details: result };
  },
};
