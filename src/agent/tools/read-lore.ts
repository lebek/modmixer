import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
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

/** Per-game label + description for a lore tool (built in <game>/research-tools.ts). */
export interface LoreToolText {
  label: string;
  description: string;
}

export function createReadLoreTool(
  game: GameId,
  text: LoreToolText,
): AgentTool<ReturnType<typeof buildParams>, ReadLoreDetails> {
  const Params = buildParams(game);
  return {
    name: 'read_lore',
    label: text.label,
    description: text.description,
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
