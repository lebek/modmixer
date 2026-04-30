import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { writeAbout } from '../workspace.js';
import { emitModChanged } from '../mod-events.js';

const Params = Type.Object({
  folder: Type.String({
    description:
      "Workspace mod folder name. The mod must already exist (i.e. scaffold_mod has been run). Use the active mod's folder from your scope.",
  }),
  name: Type.Optional(
    Type.String({
      description: "Mod display name shown in RimWorld's mod list.",
    }),
  ),
  packageId: Type.Optional(
    Type.String({
      description:
        'Reverse-DNS package id, lowercase. Example: "alebek.helloworld". Use ${defaultAuthor}.${PascalCaseName} unless the user gave a specific id.',
    }),
  ),
  author: Type.Optional(
    Type.String({
      description:
        "Author display name shown in RimWorld's mod list. Free-form (e.g. \"Peter\"); not the same as the sluggified packageId prefix.",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description:
        "Player-facing description shown in RimWorld's in-game mod list and on the Steam Workshop page. The user owns this — write to it only when they ask for a copy edit, marketing rewrite, or initial draft. The agent's own running notes about the mod live in the Schematic (use update_schematic for those).",
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
    "Patch the active mod's About.xml (Name / PackageID / Author / Description) — these are the player-facing identity and Workshop description shown in the Settings panel. For the agent's own running notes about what the mod contains, use update_schematic instead. Requires the mod to exist; for brand-new mods, scaffold_mod first.",
  parameters: Params,
  async execute(
    _id,
    params,
  ): Promise<AgentToolResult<SetModMetadataDetails>> {
    const { folder, ...rest } = params;
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
