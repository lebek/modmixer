import path from 'node:path';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TObject } from 'typebox';
import { getAgentHost } from '../agent-host.js';
import { getAdapter } from '../adapters/index.js';
import type {
  RunTestCycleDetails,
  TestCycleContext,
} from '../adapters/types.js';
import type { GameId } from '../games/types.js';

export type { RunTestCycleDetails };

/**
 * Single-call macro for the test-in-game flow. Both the parameter schema and the
 * behavior live in the adapter (RimWorld → ship/launch via Steam + ModsConfig,
 * with palette/quicktest/isolated knobs; Minecraft → gradlew runClient, folder
 * only). The macro stays thin: take the adapter's schema, lift the neutral
 * `folder`, hand the rest to the adapter as opaque params, dispatch.
 *
 * Built per conversation: `conversationId` is captured so the background bridge
 * monitor the cycle arms is bound to the chat that launched the test, even when
 * several mod tabs are open at once. The host callbacks (startMonitoring /
 * reportTestDiagnostic) are injected into the context here — that's why the
 * adapters never import agent-host.ts (avoids an import cycle).
 *
 * `cwd` is the mod folder (the session's working directory): the tested mod is
 * always the one the chat is bound to, so the schema carries no folder arg and
 * ctx.folder is derived here. Dispatch keys off the conversation's `game` (the
 * same source as the tool description and schema), so the tool the model sees
 * and the adapter it runs are always the same game.
 */
export function createRunTestCycleTool(
  conversationId: string,
  game: GameId,
  cwd: string,
): AgentTool<TObject, RunTestCycleDetails> {
  const adapter = getAdapter(game);
  return {
    name: 'run_test_cycle',
    label: 'Run test cycle (build + launch + watch)',
    description: adapter.toolText.testCycle,
    parameters: adapter.testCycleParams,
    async execute(_id, params): Promise<AgentToolResult<RunTestCycleDetails>> {
      const p = params as Record<string, unknown>;
      const ctx: TestCycleContext = {
        conversationId,
        folder: path.basename(cwd),
        params: p,
        startMonitoring: (args) => getAgentHost().startMonitoring(args),
        reportTestDiagnostic: (cid, message) =>
          getAgentHost().reportTestDiagnostic(cid, message),
      };
      return adapter.test(ctx);
    },
  };
}
