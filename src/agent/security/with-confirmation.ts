import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from '@earendil-works/pi-agent-core';
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

export interface ConfirmationOptions<TParams> {
  /**
   * Customize the modal description from the actual params (e.g. show
   * "enable Doormats in RimWorld" instead of "enable a mod"). Defaults to
   * the static copy.summary.
   */
  summarize?: (params: TParams) => string;
  /**
   * If provided and returns true at request time, the prompt is skipped
   * and the tool runs immediately. Used for the fix-session flow where
   * the user has pre-authorized a class of mutations until apply/revert.
   */
  shouldAutoApprove?: () => boolean;
}

/**
 * Wrap a tool so the user must explicitly approve before its `execute()`
 * runs. Denial throws an Error so the agent's tool-result is marked as an
 * error (the agent surfaces this back to the LLM, which can self-correct).
 */
export function withConfirmation<TParams, TDetails>(
  tool: AgentTool<any, TDetails>,
  copy: ConfirmationCopy,
  options: ConfirmationOptions<TParams> | ((params: TParams) => string) = {},
): AgentTool<any, TDetails> {
  // Back-compat: callers used to pass `summarize` as the third positional arg.
  const opts: ConfirmationOptions<TParams> =
    typeof options === 'function' ? { summarize: options } : options;
  return {
    ...tool,
    async execute(
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<TDetails>,
    ): Promise<AgentToolResult<TDetails>> {
      if (opts.shouldAutoApprove?.()) {
        return tool.execute(toolCallId, params as any, signal, onUpdate);
      }
      const typedParams = params as TParams;
      const summary = opts.summarize ? opts.summarize(typedParams) : copy.summary;
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
