import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import {
  isLoreTopicForGame,
  loreTopics,
  saveEntry,
  topicCatalogueText,
  type LoreTopic,
} from '../lore.js';
import type { LoreToolText } from './read-lore.js';
import type { GameId } from '../games/types.js';

export interface SaveLoreDetails {
  topic: LoreTopic;
  hook: string;
  action: 'created' | 'updated' | 'appended';
  file: string;
}

export function createSaveLoreTool(
  game: GameId,
  text: LoreToolText,
): AgentTool<ReturnType<typeof buildParams>, SaveLoreDetails> {
  const Params = buildParams(game);
  return {
    name: 'save_lore',
    label: text.label,
    description: text.description,
    parameters: Params,
    async execute(_id, params): Promise<AgentToolResult<SaveLoreDetails>> {
      if (!isLoreTopicForGame(params.topic, game)) {
        throw new Error(
          `Unknown topic "${params.topic}". Valid topics: ${loreTopics(game).join(', ')}.`,
        );
      }
      const result = await saveEntry(
        { topic: params.topic, hook: params.hook, markdown: params.markdown },
        game,
      );
      return {
        content: [
          {
            type: 'text',
            text: `Saved lore (${result.action}): topic=${params.topic} hook=${JSON.stringify(params.hook)}.`,
          },
        ],
        details: {
          topic: params.topic,
          hook: params.hook,
          action: result.action,
          file: result.file,
        },
      };
    },
  };
}

function buildParams(game: GameId) {
  return Type.Object({
    topic: Type.String({
      description: `Topic file to save into. Pick the closest fit. Use "misc" only when nothing else applies. Catalogue:\n${topicCatalogueText(game)}`,
    }),
    hook: Type.String({
      description:
        'Short H2-style title that uniquely identifies this lesson within the topic. The first 8–12 words of the lesson, in the form "When you want to X, do it like THIS" or similar. If an entry with this hook already exists, it is REPLACED — so re-use the same hook when correcting an earlier lesson.',
    }),
    markdown: Type.String({
      description:
        "The lesson body in markdown. Recipe + gotcha shape: 1–3 sentences on the recipe (what to do), then a short *Why it's tricky:* line explaining the failure mode. Include error messages verbatim when they're distinctive — they're what future you will grep for. Do NOT include the H2 hook line; the tool prepends it.",
    }),
  });
}
