import { createBashTool } from '@mariozechner/pi-coding-agent';
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from '@mariozechner/pi-agent-core';
import { assertCommandAllowed } from '../security/path-policy.js';

/**
 * Default kill-timer (seconds) injected when the model omits `timeout`. The
 * upstream tool has no default — a runaway command would otherwise stay alive
 * for the lifetime of the session. Matches Claude Code's default.
 */
const DEFAULT_TIMEOUT_SECONDS = 120;
/**
 * Hard cap on the model-supplied timeout. Legitimate slow commands (builds,
 * installs) shouldn't need more; anything longer is almost always a hang.
 */
const MAX_TIMEOUT_SECONDS = 600;

/**
 * Custom bash tool that wraps pi's built-in `createBashTool` with a
 * path-policy preflight and a default kill-timer. Registered under the same
 * `name: 'bash'` so the AgentSession registry replaces the built-in (custom
 * tools win in `_refreshToolRegistry`). The default cwd is the workspace;
 * the spawn already restricts the working directory to it, but a hostile
 * prompt can still pass an absolute path inside the command (e.g.
 * `cat ~/.ssh/id_rsa`), which this preflight rejects.
 *
 * `cwd` is bound at construction time to whatever the AgentHost passes,
 * matching how the built-in tool is constructed in pi.
 */
export function createGuardedBashTool(cwd: string): AgentTool<any> {
  const inner = createBashTool(cwd);

  return {
    ...inner,
    description:
      `${inner.description} If no \`timeout\` is provided, the command is killed after ` +
      `${DEFAULT_TIMEOUT_SECONDS}s. Pass an explicit timeout (max ${MAX_TIMEOUT_SECONDS}s) ` +
      `for legitimately slow commands such as builds or installs.`,
    async execute(
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ): Promise<AgentToolResult<unknown>> {
      // The built-in tool will throw on a non-zero exit; we throw at the
      // policy boundary the same way so the agent surfaces a tool-error
      // result and can self-correct.
      if (!params || typeof params !== 'object') {
        throw new Error('bash tool: missing string `command` parameter');
      }
      const p = params as { command?: unknown; timeout?: unknown };
      if (typeof p.command !== 'string') {
        throw new Error('bash tool: missing string `command` parameter');
      }
      assertCommandAllowed(p.command);
      const requested =
        typeof p.timeout === 'number' && p.timeout > 0
          ? p.timeout
          : DEFAULT_TIMEOUT_SECONDS;
      const guardedParams = { ...p, timeout: Math.min(requested, MAX_TIMEOUT_SECONDS) };
      return inner.execute(toolCallId, guardedParams as any, signal, onUpdate);
    },
  };
}
