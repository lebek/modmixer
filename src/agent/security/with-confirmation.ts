import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from '@mariozechner/pi-agent-core';
import {
  buildParamPreview,
  getConfirmationGate,
  type ConfirmationRequest,
} from './confirmation-gate.js';

/**
 * The user-facing summary line is fixed text per tool, NOT the LLM's
 * description. We don't trust the model to describe its own destructive
 * call truthfully; the modal shows what the tool *will* do regardless of
 * what the assistant said.
 */
export interface ConfirmationCopy {
  /** Imperative phrase shown as the modal title. */
  label: string;
  /** Plain-English description of what the action will do, fixed by code. */
  summary: string;
}

/**
 * Wrap a tool so the user must explicitly approve before its `execute()`
 * runs. Denial throws an Error so the agent's tool-result is marked as an
 * error (the agent surfaces this back to the LLM, which can self-correct).
 *
 * `summarize` lets the wrapper customize the modal description from the
 * actual params (e.g. show "enable Doormats in RimWorld" instead of just
 * "enable a mod"). Defaults to the static summary.
 */
export function withConfirmation<TParams, TDetails>(
  tool: AgentTool<any, TDetails>,
  copy: ConfirmationCopy,
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
      const typedParams = params as TParams;
      const summary = summarize ? summarize(typedParams) : copy.summary;
      const request: Omit<ConfirmationRequest, 'id'> = {
        tool: tool.name,
        label: copy.label,
        summary,
        paramPreview: buildParamPreview(
          params as Record<string, unknown> | null | undefined,
        ),
      };
      const decision = await getConfirmationGate().request(request, params);
      if (!decision.approved) {
        throw new Error(
          `User denied permission to run ${tool.name}. Do not retry without confirming with the user first.`,
        );
      }
      return tool.execute(toolCallId, params as any, signal, onUpdate);
    },
  };
}
