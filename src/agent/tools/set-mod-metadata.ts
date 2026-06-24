import { Type } from 'typebox';
import path from 'node:path';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { getWorkspacePaths, writeAbout } from '../workspace.js';
import { emitModChanged } from '../mod-events.js';
import { readModPrefs } from '../mod-prefs.js';
import { writeMinecraftMeta } from '../minecraft/scaffold.js';

const Params = Type.Object({
  folder: Type.String({
    description:
      "Workspace mod folder name. The mod must already exist (i.e. scaffold_mod has been run). Use the active mod's folder from your scope.",
  }),
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

export const setModMetadataTool: AgentTool<typeof Params, SetModMetadataDetails> = {
  name: 'set_mod_metadata',
  label: 'Set mod metadata',
  description:
    "Set the active mod's display identity (Name / Id / Author / Description). RimWorld writes About.xml; Minecraft writes gradle.properties (and renaming the id rebrands the whole project). Use this to give a freshly-created 'Untitled Mod' a sensible name + id once you understand what the user wants. For the agent's own running notes, use update_schematic instead.",
  parameters: Params,
  async execute(
    _id,
    params,
  ): Promise<AgentToolResult<SetModMetadataDetails>> {
    const { folder, ...rest } = params;

    // Minecraft mods have no About.xml — identity lives in gradle.properties.
    // Map the canonical fields onto it (and rebrand the project when the id
    // changes so @Mod keeps matching the manifest).
    const prefs = await readModPrefs(folder);
    if (prefs.game === 'minecraft') {
      const { workspaceDir } = getWorkspacePaths();
      const modDir = path.join(workspaceDir, folder);
      const changed = await writeMinecraftMeta(modDir, {
        name: rest.name,
        author: rest.author,
        description: rest.description,
        modId: rest.packageId,
      });
      if (changed.length === 0) {
        throw new Error('set_mod_metadata called with no fields to update.');
      }
      emitModChanged(folder);
      return {
        content: [
          {
            type: 'text',
            text: `Updated gradle.properties for ${folder} (${changed.join(', ')}). The mod's name/id now reflect this${changed.includes('modId') ? ' — the @Mod id, package, and resource namespaces were renamed to match' : ''}.`,
          },
        ],
        details: { folder, fields: changed },
      };
    }

    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (typeof v === 'string') patch[k] = v;
    }
    if (Object.keys(patch).length === 0) {
      throw new Error('set_mod_metadata called with no fields to update.');
    }
    const updated = await writeAbout(folder, patch);
    if (!updated) {
      throw new Error(
        `Mod folder not found: ${folder}. Run scaffold_mod first.`,
      );
    }
    emitModChanged(folder);
    const summary = Object.entries(patch)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ');
    return {
      content: [
        {
          type: 'text',
          text: `Updated About.xml for ${folder} (${summary}). The Settings panel reflects this now.`,
        },
      ],
      details: { folder, fields: Object.keys(patch) },
    };
  },
};
