import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import {
  enableModInGame,
  isRimWorldRunning,
  launchRimWorldViaSteam,
} from '../game.js';
import { syncModToGame } from '../workspace.js';

const Params = Type.Object({
  folder: Type.String({
    description: 'Workspace mod folder name to ship to RimWorld and launch.',
  }),
});

export interface ShipAndLaunchDetails {
  folder: string;
  /** packageId discovered in About.xml. */
  packageId: string;
  alreadyEnabled: boolean;
  /** True if RimWorld was already running when we tried to launch. */
  alreadyRunning: boolean;
}

/**
 * Single-call replacement for `sync_to_game` → `enable_mod_in_game` →
 * `launch_rimworld`, which the agent always runs in that order in the
 * test-in-game flow. Bundling them removes 2 round-trips per cycle and
 * makes intent explicit.
 *
 * RimWorld must be CLOSED — the same precondition as `enable_mod_in_game`,
 * since it edits ModsConfig.xml. We check up front and refuse with a clear
 * message instead of letting the inner call raise. The agent should pair
 * this with `quit_rimworld` (which now blocks until exit) when RimWorld
 * was already running.
 */
export const shipAndLaunchTool: AgentTool<typeof Params, ShipAndLaunchDetails> = {
  name: 'ship_and_launch',
  label: 'Ship mod & launch RimWorld',
  description:
    "Symlink the mod into RimWorld's Mods/, add it to ModsConfig.xml's <activeMods>, and cold-start the game via Steam — all in one call. Equivalent to sync_to_game + enable_mod_in_game + launch_rimworld. RimWorld must be CLOSED when this runs (the game rewrites ModsConfig.xml on quit). Pair with quit_rimworld first if it's running. After this returns, call watch_player_log to begin background error monitoring; do NOT block the user's turn waiting for them to test.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<ShipAndLaunchDetails>> {
    if (await isRimWorldRunning()) {
      throw new Error(
        'RimWorld is currently running. ship_and_launch needs the game closed so it can edit ModsConfig.xml. Confirm with the user, then call quit_rimworld first (it now blocks until the process exits), then retry ship_and_launch.',
      );
    }

    // Order matters: sync first (creates the Mods/<folder> symlink + asset
    // stubs), then enable (writes <activeMods>), then launch. If sync fails
    // we don't want a half-baked enable; if enable fails we don't want to
    // launch into a broken state.
    await syncModToGame(params.folder);
    const enable = await enableModInGame(params.folder);
    const launch = await launchRimWorldViaSteam();

    const lines: string[] = [];
    lines.push(`Synced ${params.folder} into RimWorld's Mods/.`);
    lines.push(
      enable.alreadyEnabled
        ? `${enable.packageId} was already in <activeMods>.`
        : `Added ${enable.packageId} to <activeMods>.`,
    );
    lines.push(
      launch.alreadyRunning
        ? // Should be unreachable given the precheck, but keep the message
          // in case Steam launches a stray instance between the check and
          // the open call.
          'RimWorld was running again by launch time; Steam URL is a no-op. Tell the user to quit and retry.'
        : 'Launched RimWorld via Steam.',
    );

    return {
      content: [{ type: 'text', text: lines.join(' ') }],
      details: {
        folder: params.folder,
        packageId: enable.packageId,
        alreadyEnabled: enable.alreadyEnabled,
        alreadyRunning: launch.alreadyRunning,
      },
    };
  },
};
