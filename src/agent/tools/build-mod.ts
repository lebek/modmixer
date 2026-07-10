import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { getAdapter } from '../adapters/index.js';
import type { GameId } from '../games/types.js';
import type { BuildModDetails } from '../adapters/types.js';

export type { BuildModDetails };

const Params = Type.Object({});

/**
 * Compile the active mod. `cwd` is the mod folder (the session's working
 * directory) and `game` is the conversation's game, so the tool takes no folder
 * arg — it always builds the mod the chat is bound to, dispatched to that
 * game's adapter (RimWorld → dotnet, Minecraft → gradle).
 */
export function createBuildModTool(
  cwd: string,
  game: GameId,
): AgentTool<typeof Params, BuildModDetails> {
  return {
    name: 'build_mod',
    label: 'Build mod',
    description:
      "Compile this mod and return the full build output (errors, warnings, success summary) so you can read compile errors and fix them. RimWorld mods run `dotnet build` in Source/ (needs the .NET SDK + a .csproj — add one with add_csharp if the mod is still XML-only). Minecraft (NeoForge) mods run `./gradlew build` in the project root (the first build decompiles Minecraft and can take several minutes).",
    parameters: Params,
    async execute(_id, _params, signal): Promise<AgentToolResult<BuildModDetails>> {
      return getAdapter(game).build(cwd, signal);
    },
  };
}
