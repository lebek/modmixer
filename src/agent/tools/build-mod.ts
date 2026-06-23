import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import path from 'node:path';
import { getWorkspacePaths } from '../workspace.js';
import { readModPrefs } from '../mod-prefs.js';
import { getAdapter } from '../adapters/index.js';
import type { BuildModDetails } from '../adapters/types.js';

export type { BuildModDetails };

const Params = Type.Object({
  modFolder: Type.String({
    description: 'Mod folder name relative to Mods/, e.g. "HelloWorld".',
  }),
});

export const buildModTool: AgentTool<typeof Params, BuildModDetails> = {
  name: 'build_mod',
  label: 'Build mod',
  description:
    "Compile the mod and return the full build output (errors, warnings, success summary) so you can read compile errors and fix them. RimWorld mods run `dotnet build` in Source/ (needs the .NET SDK + a .csproj). Minecraft (NeoForge) mods run `./gradlew build` in the project root (the first build decompiles Minecraft and can take several minutes).",
  parameters: Params,
  async execute(_id, params, signal): Promise<AgentToolResult<BuildModDetails>> {
    // Per-game build is dispatched through the adapter (RimWorld → dotnet,
    // Minecraft → gradle). `prefs.game` is resolved (defaults to rimworld) in
    // readModPrefs, so an old mod with no game field builds as RimWorld.
    const { workspaceDir } = getWorkspacePaths();
    const modDir = path.join(workspaceDir, params.modFolder);
    const prefs = await readModPrefs(params.modFolder);
    return getAdapter(prefs.game).build(modDir, signal);
  },
};
