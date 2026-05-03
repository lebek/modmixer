import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { launchRimWorld, type LaunchResult } from '../game.js';

const Params = Type.Object({
  quicktest: Type.Optional(
    Type.Boolean({
      description:
        "When true, pass `-quicktest` so RimWorld bypasses the main menu and drops the user straight into a generated map (no scenario picker, no colonist setup). The test-in-game flow defaults this to true — only skip it when the test genuinely needs the menus (ScenarioDef in the scenario picker, a custom main-menu UI, mod options, save-load flows, etc.). Defaults to false here so non-test launches don't blow past the user's main menu unexpectedly.",
    }),
  ),
});

export const launchRimWorldTool: AgentTool<typeof Params, LaunchResult> = {
  name: 'launch_rimworld',
  label: 'Launch RimWorld',
  description:
    "Cold-start RimWorld by spawning the game executable directly (Steam still has to be running for Steamworks, but we don't go through the Steam URL). NO-OP if RimWorld is already running — this does NOT reload mods. Run sync_to_game and enable_mod_in_game first when testing a workspace mod. Pass quicktest=true (default in the test flow) to skip menus and land in a generated map.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<LaunchResult>> {
    const args = params.quicktest === true ? ['-quicktest'] : [];
    const result = await launchRimWorld({ args });
    const text = result.alreadyRunning
      ? 'RimWorld is already running — launch is a no-op (does not reload mods). Ask the user to quit RimWorld and retry, or use the quit_rimworld tool if they confirm.'
      : `Launched ${result.executable}${result.args.length ? ' ' + result.args.join(' ') : ''}. The game window should appear shortly.`;
    return { content: [{ type: 'text', text }], details: result };
  },
};
