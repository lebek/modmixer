import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import {
  LORE_TOPICS,
  isLoreTopic,
  saveEntry,
  topicCatalogueText,
  type LoreTopic,
} from '../lore.js';

const Params = Type.Object({
  topic: Type.String({
    description: `Topic file to save into. Pick the closest fit. Use "misc" only when nothing else applies — repeated misc entries are a signal the taxonomy needs a new topic; flag it to the user rather than burying lessons there. If the lesson spans two topics, file it under the more specific one. Catalogue:
${topicCatalogueText()}`,
  }),
  hook: Type.String({
    description:
      'Short H2-style title that uniquely identifies this lesson within the topic. The first 8–12 words of the lesson, in the form "When you want to X, do it like THIS" or similar. If an entry with this hook already exists, it is REPLACED — so re-use the same hook when correcting an earlier lesson.',
  }),
  markdown: Type.String({
    description:
      'The lesson body in markdown. Recipe + gotcha shape: 1–3 sentences on the recipe (what to do), then a short *Why it\'s tricky:* line explaining the failure mode. Include error messages verbatim when they\'re distinctive — they\'re what future you will grep for. Do NOT include the H2 hook line; the tool prepends it.',
  }),
});

export interface SaveLoreDetails {
  topic: LoreTopic;
  hook: string;
  action: 'created' | 'updated' | 'appended';
  file: string;
}

export const saveLoreTool: AgentTool<typeof Params, SaveLoreDetails> = {
  name: 'save_lore',
  label: 'Save modding lore',
  description:
    'Persist a transferable engine-level modding lesson into the user-global lore so future sessions can consult it. Save sparingly — only when the lesson is broadly applicable across mods AND would NOT be obvious to an agent reading the code cold AND would have saved you significant time. Strong signals: the obvious approach failed, an error message was distinctive, the user corrected your assumption, the fix turned out to be in a different file/system than you first searched. Re-use an existing hook to update a lesson rather than appending a near-duplicate. Do NOT save mod-specific quirks here.',
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<SaveLoreDetails>> {
    if (!isLoreTopic(params.topic)) {
      throw new Error(
        `Unknown topic "${params.topic}". Valid topics: ${LORE_TOPICS.join(', ')}.`,
      );
    }
    const result = await saveEntry({
      topic: params.topic,
      hook: params.hook,
      markdown: params.markdown,
    });
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
