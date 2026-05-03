// Variant of `withConfirmation` that skips the prompt when an "auto-approve"
// gate function returns true. The fix-session use-case: while a session is
// active, the agent has user-granted permission to mutate the active mod
// list freely (apply or revert decides what happens at the end), but outside
// a session the same tool calls require explicit consent.
//
// We don't reuse withConfirmation directly because we want the predicate
// evaluated at request time, not registration time.

import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from '@mariozechner/pi-agent-core';
import {
  buildParamPreview,
  getConfirmationGate,
} from './confirmation-gate.js';

interface ConfirmationCopy {
  label: string;
  summary: string;
}

export function withSessionConfirmation<TParams, TDetails>(
  tool: AgentTool<any, TDetails>,
  copy: ConfirmationCopy,
  shouldAutoApprove: () => boolean,
  summarize?: (params: TParams) => string,
): AgentTool<any, TDetails> {
  return {
    ...tool,
    async execute(
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<TDetails>,
    ): Promise<AgentToolResult<TDetails>> {
      if (shouldAutoApprove()) {
        return tool.execute(toolCallId, params as any, signal, onUpdate);
      }
      const typedParams = params as TParams;
      const summary = summarize ? summarize(typedParams) : copy.summary;
      const decision = await getConfirmationGate().request(
        {
          tool: tool.name,
          label: copy.label,
          summary,
          paramPreview: buildParamPreview(
            params as Record<string, unknown> | null | undefined,
          ),
        },
        params,
      );
      if (!decision.approved) {
        throw new Error(`User denied permission to run ${tool.name}.`);
      }
      return tool.execute(toolCallId, params as any, signal, onUpdate);
    },
  };
}
