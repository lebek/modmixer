import {
  createSyntheticSourceInfo,
  type ContextEvent,
  type Extension,
} from '@mariozechner/pi-coding-agent';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';

// pi-coding-agent's `ContextEventResult` is the return contract for the
// "context" event handler; it isn't re-exported at the package root, so the
// shape is mirrored here to avoid a deep subpath import.
interface ContextEventResult {
  messages?: AgentMessage[];
}

/**
 * Build a pi-coding-agent extension that strips `thinking` content blocks
 * from older assistant messages before each LLM call.
 *
 * Why: thinking blocks are persisted in the session transcript (so the UI can
 * render past reasoning, and so providers that need signature-continuity get
 * it). Once we're past that point the historical blocks are dead weight on
 * the input side — Kimi K2.6 in particular emits 1–13 KB blocks per turn,
 * and a long session pays for them on every subsequent request. Stripping
 * conservatively still saves real tokens with no quality impact.
 *
 * What we KEEP (in priority order):
 *   1. Thinking on the LAST assistant message. Anthropic's extended-thinking
 *      contract requires the prior assistant's signed thinking block to be
 *      present verbatim when the next request includes tool_results.
 *   2. Thinking on any "thinking-only" assistant message — a turn whose only
 *      content blocks are thinking (no text, no toolCall). Kimi sometimes
 *      returns control to the user this way and the UI renders the thinking
 *      as the visible reply; dropping those would erase chat history.
 *   3. Thinking on any assistant message that contains a tool call. Kimi
 *      K2.6 on OpenRouter (and likely other reasoning models on the
 *      openai-completions API surface) rejects requests with
 *      `thinking is enabled but reasoning_content is missing in assistant
 *      tool call message at index N` when reasoning is on but a prior
 *      tool-call message has had its thinking stripped. There's no per-API
 *      gate for this — the safe default is to keep thinking on ALL
 *      tool-calling assistant turns, not just the most recent.
 *
 * What we DROP: thinking on assistant messages that have text content but
 * no tool calls, and aren't the last assistant. Those are intermediate
 * "I'm narrating progress to the user" replies whose reasoning is no
 * longer load-bearing on subsequent turns.
 */
export function buildStripThinkingExtension(): Extension {
  // Construct an Extension shell directly. pi-coding-agent's
  // loadExtensionFromFactory is not re-exported at the package root, and the
  // file/jiti machinery it uses is overkill for an in-process pure handler.
  // The runner only ever inspects ext.path and ext.handlers; the other Maps
  // are required by the type but stay empty.
  const path = '<modmixer:strip-thinking>';
  const handler = async (
    event: ContextEvent,
  ): Promise<ContextEventResult> => ({
    messages: stripThinking(event.messages),
  });
  return {
    path,
    resolvedPath: path,
    sourceInfo: createSyntheticSourceInfo(path, {
      source: 'modmixer',
      scope: 'temporary',
      origin: 'top-level',
    }),
    handlers: new Map([['context', [handler as never]]]),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

/**
 * Pure transform exported for tests. See buildStripThinkingExtension's
 * doc-comment for the rules.
 */
export function stripThinking(messages: AgentMessage[]): AgentMessage[] {
  // Find the index of the last assistant message — its thinking is preserved
  // unconditionally (Anthropic signature-continuity for the next turn).
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isAssistant(messages[i])) {
      lastAssistantIdx = i;
      break;
    }
  }

  return messages.map((message, i) => {
    if (!isAssistant(message)) return message;
    if (i === lastAssistantIdx) return message;
    if (!Array.isArray(message.content)) return message;

    const hasToolCall = message.content.some((b) => b.type === 'toolCall');
    // Provider-side reasoning-content rule: any assistant turn that
    // contains a tool call must retain its thinking block when reasoning
    // is on. Kimi K2.6 enforces this for every tool-call message in the
    // request, not just the most recent.
    if (hasToolCall) return message;

    const hasNonThinking = message.content.some((b) => b.type !== 'thinking');
    // Thinking-only turn — Kimi-style "reply via thinking block". Keep as-is
    // so we don't erase a user-visible message.
    if (!hasNonThinking) return message;

    const stripped = message.content.filter((b) => b.type !== 'thinking');
    if (stripped.length === message.content.length) return message;
    return { ...message, content: stripped } as AssistantMessage;
  });
}

function isAssistant(message: AgentMessage): message is AssistantMessage {
  return (message as { role?: string }).role === 'assistant';
}
