import { Type } from 'typebox';
import path from 'node:path';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { type AboutMetadata } from '../workspace.js';
import { getAdapter } from '../adapters/index.js';
import { emitModChanged } from '../mod-events.js';
import type { GameId } from '../games/types.js';

const Params = Type.Object({
  name: Type.Optional(
    Type.String({
      description:
        "Mod display name/title (RimWorld: About.xml <name>; Minecraft: gradle.properties mod_name). Set this to give an untitled mod a sensible title.",
    }),
  ),
  packageId: Type.Optional(
    Type.String({
      description:
        'Mod id. RimWorld: reverse-DNS lowercase, e.g. "alebek.helloworld" (use ${defaultAuthor}.${PascalCaseName}). Minecraft: a short lowercase id (letters/digits/underscore only), e.g. "foobargreeter" — changing it rebrands the whole project (@Mod id, package, resource namespaces).',
    }),
  ),
  author: Type.Optional(
    Type.String({
      description:
        "Author display name shown in the game's mod list (RimWorld: About.xml <author>; Minecraft: gradle.properties). Free-form (e.g. \"Peter\"); not the same as the sluggified packageId prefix.",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description:
        "Player-facing description shown in the game's mod list and on its published page (RimWorld: in-game list + Steam Workshop; Minecraft: Modrinth). The user owns this — write to it only when they ask for a copy edit, marketing rewrite, or initial draft. The agent's own running notes about the mod live in the Schematic (use update_schematic for those).",
    }),
  ),
});

export interface SetModMetadataDetails {
  folder: string;
  fields: string[];
}

/**
 * Set the active mod's identity. `cwd` is the mod folder (the session's working
 * directory) and `game` is the conversation's game, so the tool takes no folder
 * arg — it always writes the mod the chat is bound to, via that game's adapter.
 */
export function createSetModMetadataTool(
  cwd: string,
  game: GameId,
): AgentTool<typeof Params, SetModMetadataDetails> {
  return {
    name: 'set_mod_metadata',
    label: 'Set mod metadata',
    description:
      "Set this mod's display identity (Name / Id / Author / Description). RimWorld writes About.xml; Minecraft writes gradle.properties (and renaming the id rebrands the whole project). Use this to give a freshly-created 'Untitled Mod' a sensible name + id once you understand what the user wants. For the agent's own running notes, use update_schematic instead.",
    parameters: Params,
    async execute(_id, params): Promise<AgentToolResult<SetModMetadataDetails>> {
      const folder = path.basename(cwd);

      // Build the canonical identity patch; the game's adapter maps it onto its
      // own format (RimWorld About.xml / Minecraft gradle.properties) and
      // reports back what changed plus a game-specific success line.
      const patch: Partial<AboutMetadata> = {};
      for (const [k, v] of Object.entries(params)) {
        if (typeof v === 'string') (patch as Record<string, string>)[k] = v;
      }
      if (Object.keys(patch).length === 0) {
        throw new Error('set_mod_metadata called with no fields to update.');
      }

      const { changed, message } = await getAdapter(game).writeModMetadata(
        cwd,
        folder,
        patch,
      );
      emitModChanged(folder);
      return {
        content: [{ type: 'text', text: message }],
        details: { folder, fields: changed },
      };
    },
  };
}
