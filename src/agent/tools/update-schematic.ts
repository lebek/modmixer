import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { writeSchematic } from '../schematic.js';
import { emitModChanged } from '../mod-events.js';

const Params = Type.Object({
  folder: Type.String({
    description:
      "Workspace mod folder name. The mod must already exist (i.e. scaffold_mod has been run). Use the active mod's folder from your scope.",
  }),
  shortDescription: Type.Optional(
    Type.String({
      description:
        'One-sentence summary (~300 chars max) shown in the mod browser and chat header. Update whenever the high-level pitch changes.',
    }),
  ),
  body: Type.Optional(
    Type.String({
      description:
        "Markdown notes covering every feature the mod adds and how it works (mechanics, triggers, balance, anything worth remembering across conversations). The Schematic page lists every Def in the mod live, so do NOT restate raw XML here — describe behavior. Pass the full intended body each call; this replaces the previous body.",
    }),
  ),
});

export interface UpdateSchematicDetails {
  folder: string;
  fields: string[];
}

export const updateSchematicTool: AgentTool<typeof Params, UpdateSchematicDetails> = {
  name: 'update_schematic',
  label: 'Update schematic',
  description:
    "Patch the agent-owned Schematic for a workspace mod (sidecar at <modFolder>/.modmixer/schematic.json). The Schematic is the agent's running spec — what the mod is, what it includes, how each piece works. The user sees it read-only on the Schematic page alongside a live list of Defs. Call this whenever the mod gains or meaningfully changes a feature, and whenever the pitch shifts. About.xml's <description> is for the player and is owned by the user — don't write to it via this tool.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<UpdateSchematicDetails>> {
    const { folder, shortDescription, body } = params;
    const patch: { shortDescription?: string; body?: string } = {};
    if (typeof shortDescription === 'string') patch.shortDescription = shortDescription;
    if (typeof body === 'string') patch.body = body;
    if (Object.keys(patch).length === 0) {
      throw new Error('update_schematic called with no fields to update.');
    }
    const updated = await writeSchematic(folder, patch);
    if (!updated) {
      throw new Error(
        `Mod folder not found: ${folder}. Run scaffold_mod first.`,
      );
    }
    emitModChanged(folder);
    const fields = Object.keys(patch);
    return {
      content: [
        {
          type: 'text',
          text: `Updated schematic for ${folder} (${fields.join(', ')}). The Schematic panel reflects this now.`,
        },
      ],
      details: { folder, fields },
    };
  },
};
