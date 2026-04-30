import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { enableModInGame, disableModInGame, type EnableResult, type DisableResult } from '../game.js';

const EnableParams = Type.Object({
  folder: Type.String({
    description: 'Workspace mod folder name. Reads its About.xml for packageId.',
  }),
});

export const enableModInGameTool: AgentTool<typeof EnableParams, EnableResult> = {
  name: 'enable_mod_in_game',
  label: 'Enable mod in RimWorld',
  description:
    "Add the mod's packageId to RimWorld's ModsConfig.xml <activeMods> list so it loads on next launch. Pair with sync_to_game (creates the symlink) and launch_rimworld for a one-shot test cycle. RimWorld must be CLOSED when this runs — the game rewrites ModsConfig.xml on quit and would overwrite your edits otherwise.",
  parameters: EnableParams,
  async execute(_id, params): Promise<AgentToolResult<EnableResult>> {
    const result = await enableModInGame(params.folder);
    const text = result.alreadyEnabled
      ? `${result.packageId} was already enabled in ModsConfig.xml.`
      : `Enabled ${result.packageId} in ModsConfig.xml. RimWorld will load it on next launch.`;
    return { content: [{ type: 'text', text }], details: result };
  },
};

const DisableParams = Type.Object({
  folder: Type.String({
    description: 'Workspace mod folder name to remove from RimWorld\'s active mod list.',
  }),
});

export const disableModInGameTool: AgentTool<typeof DisableParams, DisableResult> = {
  name: 'disable_mod_in_game',
  label: 'Disable mod in RimWorld',
  description:
    "Remove the mod's packageId from ModsConfig.xml's <activeMods>. RimWorld stops loading it on next launch. The mod stays in the workspace and can be re-enabled with enable_mod_in_game.",
  parameters: DisableParams,
  async execute(_id, params): Promise<AgentToolResult<DisableResult>> {
    const result = await disableModInGame(params.folder);
    const text = result.wasEnabled
      ? `Disabled ${result.packageId} in ModsConfig.xml.`
      : `${result.packageId} was not in <activeMods>; nothing to do.`;
    return { content: [{ type: 'text', text }], details: result };
  },
};
