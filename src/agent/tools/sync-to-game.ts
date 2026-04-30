import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { syncModToGame, unsyncModFromGame } from '../workspace.js';

const SyncParams = Type.Object({
  folder: Type.String({
    description: 'Workspace mod folder name to make active in RimWorld.',
  }),
});

export const syncToGameTool: AgentTool<typeof SyncParams, { folder: string; active: true }> = {
  name: 'sync_to_game',
  label: 'Sync mod to game',
  description:
    "Create a symlink from RimWorld's Mods/ to the workspace mod folder so the game loads it. Also runs the asset scanner, which writes placeholder PNGs/OGGs at any referenced asset paths the user hasn't filled in yet — so the mod loads cleanly even with incomplete assets. The user has to enable it in RimWorld's mod list and restart the game for changes to take effect.",
  parameters: SyncParams,
  async execute(_id, params): Promise<AgentToolResult<{ folder: string; active: true }>> {
    await syncModToGame(params.folder);
    return {
      content: [
        {
          type: 'text',
          text: `Synced ${params.folder} to RimWorld's Mods/ folder. Enable it in the in-game mod list and restart RimWorld.`,
        },
      ],
      details: { folder: params.folder, active: true },
    };
  },
};

const UnsyncParams = Type.Object({
  folder: Type.String({
    description: 'Workspace mod folder name to deactivate in RimWorld.',
  }),
});

export const unsyncFromGameTool: AgentTool<typeof UnsyncParams, { folder: string; active: false }> = {
  name: 'unsync_from_game',
  label: 'Unsync mod from game',
  description:
    "Remove the symlink in RimWorld's Mods/ that points to a workspace mod. The mod stays in the workspace; this just stops the game from loading it.",
  parameters: UnsyncParams,
  async execute(_id, params): Promise<AgentToolResult<{ folder: string; active: false }>> {
    await unsyncModFromGame(params.folder);
    return {
      content: [
        {
          type: 'text',
          text: `Removed symlink for ${params.folder}. RimWorld will no longer load it.`,
        },
      ],
      details: { folder: params.folder, active: false },
    };
  },
};
