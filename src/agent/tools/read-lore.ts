import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import {
  LORE_TOPICS,
  isLoreTopic,
  readTopic,
  topicCatalogueText,
  type LoreTopic,
} from '../lore.js';

const Params = Type.Object({
  topic: Type.String({
    description: `The lore topic to read. Catalogue:
${topicCatalogueText()}`,
  }),
  modFolder: Type.Optional(
    Type.String({
      description:
        "The active mod folder to also pull per-mod lore for. Omit when not scoped to a mod or when you don't want mod-specific lore.",
    }),
  ),
});

export interface ReadLoreDetails {
  topic: LoreTopic;
  modFolder: string | null;
  entryCount: number;
}

export const readLoreTool: AgentTool<typeof Params, ReadLoreDetails> = {
  name: 'read_lore',
  label: 'Read modding lore',
  description:
    'Read transferable RimWorld-modding lessons for a given topic, merged across the three lore tiers (repo → user → mod). Each entry is a markdown section starting with an `## ` hook line. When entries from different tiers cover the same hook, prefer the more specific tier (mod > user > repo) — they are returned in that order so later entries override earlier ones. Call this BEFORE attempting work in an unfamiliar area (e.g. before authoring a new SoundDef, before patching weather, before adding Harmony) — most of these lessons document non-obvious gotchas that took a long time to discover.',
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<ReadLoreDetails>> {
    if (!isLoreTopic(params.topic)) {
      throw new Error(
        `Unknown topic "${params.topic}". Valid topics: ${LORE_TOPICS.join(', ')}.`,
      );
    }
    const modFolder = params.modFolder ?? null;
    const entries = await readTopic(params.topic, modFolder);
    if (entries.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No lore entries for topic "${params.topic}"${modFolder ? ` (mod ${modFolder})` : ''} yet.`,
          },
        ],
        details: { topic: params.topic, modFolder, entryCount: 0 },
      };
    }
    // Render in tier order so the agent can see precedence at a glance.
    // Each entry is prefixed with its tier so the agent can reason about
    // "which tier does this come from" without re-reading the files.
    const blocks = entries.map(
      (e) => `<!-- tier: ${e.tier} -->\n${e.markdown}`,
    );
    return {
      content: [
        {
          type: 'text',
          text: blocks.join('\n\n'),
        },
      ],
      details: {
        topic: params.topic,
        modFolder,
        entryCount: entries.length,
      },
    };
  },
};
