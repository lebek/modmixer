import { createBashTool } from '@mariozechner/pi-coding-agent';
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from '@mariozechner/pi-agent-core';
import { assertCommandAllowed } from '../security/path-policy.js';

/**
 * Custom bash tool that wraps pi's built-in `createBashTool` with a
 * path-policy preflight. Registered under the same `name: 'bash'` so the
 * AgentSession registry replaces the built-in (custom tools win in
 * `_refreshToolRegistry`). The default cwd is the workspace; the spawn
 * already restricts the working directory to it, but a hostile prompt can
 * still pass an absolute path inside the command (e.g. `cat ~/.ssh/id_rsa`),
 * which this preflight rejects.
 *
 * `cwd` is bound at construction time to whatever the AgentHost passes,
 * matching how the built-in tool is constructed in pi.
 */
export function createGuardedBashTool(cwd: string): AgentTool<any> {
  const inner = createBashTool(cwd);

  return {
    ...inner,
    async execute(
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ): Promise<AgentToolResult<unknown>> {
      // The built-in tool will throw on a non-zero exit; we throw at the
      // policy boundary the same way so the agent surfaces a tool-error
      // result and can self-correct.
      const command =
        params && typeof params === 'object' && 'command' in params
          ? (params as { command: unknown }).command
          : null;
      if (typeof command !== 'string') {
        throw new Error('bash tool: missing string `command` parameter');
      }
      assertCommandAllowed(command);
      return inner.execute(toolCallId, params as any, signal, onUpdate);
    },
  };
}
