import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import {
  isLoreTopicForGame,
  loreTopics,
  readTopic,
  topicCatalogueText,
  type LoreTopic,
} from '../lore.js';
import type { GameId } from '../games/types.js';

export interface ReadLoreDetails {
  topic: LoreTopic;
  entryCount: number;
}

export function createReadLoreTool(
  game: GameId = 'rimworld',
): AgentTool<ReturnType<typeof buildParams>, ReadLoreDetails> {
  const isMc = game === 'minecraft';
  const Params = buildParams(game);
  return {
    name: 'read_lore',
    label: isMc ? 'Read Minecraft modding lore' : 'Read modding lore',
    description: isMc
      ? 'Read transferable Minecraft (NeoForge) modding lessons for a given topic, merged across the lore tiers (repo → user). Each entry is a markdown section starting with an `## ` hook line; user entries override repo on the same hook. Call this BEFORE work in an unfamiliar area (registering blocks/items, events, datagen, mixins, networking) — the lessons capture non-obvious NeoForge gotchas.'
      : 'Read transferable RimWorld-modding lessons for a given topic, merged across the lore tiers (repo → user). Each entry is a markdown section starting with an `## ` hook line. When entries from different tiers cover the same hook, prefer the more specific tier (user > repo) — they are returned in that order so later entries override earlier ones. Call this BEFORE attempting work in an unfamiliar area (e.g. before authoring a new SoundDef, before patching weather, before adding Harmony) — most of these lessons document non-obvious gotchas that took a long time to discover.',
    parameters: Params,
    async execute(_id, params): Promise<AgentToolResult<ReadLoreDetails>> {
      if (!isLoreTopicForGame(params.topic, game)) {
        throw new Error(
          `Unknown topic "${params.topic}". Valid topics: ${loreTopics(game).join(', ')}.`,
        );
      }
      const entries = await readTopic(params.topic, game);
      if (entries.length === 0) {
        return {
          content: [
            { type: 'text', text: `No lore entries for topic "${params.topic}" yet.` },
          ],
          details: { topic: params.topic, entryCount: 0 },
        };
      }
      const blocks = entries.map((e) => `<!-- tier: ${e.tier} -->\n${e.markdown}`);
      return {
        content: [{ type: 'text', text: blocks.join('\n\n') }],
        details: { topic: params.topic, entryCount: entries.length },
      };
    },
  };
}

function buildParams(game: GameId) {
  return Type.Object({
    topic: Type.String({
      description: `The lore topic to read. Catalogue:\n${topicCatalogueText(game)}`,
    }),
  });
}
