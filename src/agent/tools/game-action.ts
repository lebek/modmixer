import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { getLiveServer } from '../live/server.js';
import { buildActionAssembly } from '../live/build.js';
import type { ConversationScope } from '../conversations.js';

const Params = Type.Object({
  code: Type.String({
    description:
      'A complete C# compilation unit: using directives + `public static class LiveAction { public static string Run() { ... } }`. Run() executes on the game\'s main thread inside a loading event (the sim does not tick while it runs; the player\'s time speed is untouched), with full Verse/RimWorld API access, and its return string is shown to you. Throwing is fine — you get the full exception + stack back to iterate on. Do not block the thread, do not start threads that touch game state, and never define scribed/savable types here (the assembly can\'t be unloaded; persistent things belong in the session mod via apply_live).',
  }),
});

export interface GameActionDetails {
  buildOk: boolean;
  assemblyName: string | null;
  cmdOk: boolean;
  cmdDetail: string;
}

/**
 * One-shot arbitrary C# in the running game — the open-ended replacement
 * for a fixed "spawn/incident/weather" primitive vocabulary. The snippet
 * is compiled app-side in an isolated scratch project (never touching the
 * session mod's Source/), loaded by the in-game Live mod, and invoked once
 * inside a try/catch. The Live mod arms a GenSpawn ledger for the duration
 * of the invocation, so spawned things are recorded for future undo.
 */
export function createGameActionTool(
  getActiveScope: () => ConversationScope | null,
): AgentTool<typeof Params, GameActionDetails> {
  return {
    name: 'game_action',
    label: 'Run one-shot game action',
    description:
      'Execute a one-shot C# action in the RUNNING game, right now ("attack the colony with geese", "make it rain", "give a colonist a skill"). Compiles your snippet and invokes its static LiveAction.Run() on the main thread; the game keeps its current time speed. Nothing persists in the mod source — for behavior that should persist, edit the session mod and use apply_live instead. On exception you get the full stack back: read it, fix the snippet, retry.',
    parameters: Params,
    async execute(_id, params, signal): Promise<AgentToolResult<GameActionDetails>> {
      const scope = getActiveScope();
      if (!scope || scope.type !== 'mod') {
        throw new Error('game_action needs a mod-scoped live conversation.');
      }
      const live = getLiveServer();
      if (!live.isConnected()) {
        throw new Error(
          'No live game connected — the player may have closed RimWorld. Ask them to relaunch the live session from Modmixer.',
        );
      }

      const build = await buildActionAssembly(scope.modFolder, params.code, signal);
      if (!build.ok || !build.dllPath) {
        return {
          content: [
            {
              type: 'text',
              text: `SNIPPET BUILD FAILED — nothing ran in the game.\n\n${build.output}`,
            },
          ],
          details: {
            buildOk: false,
            assemblyName: build.assemblyName || null,
            cmdOk: false,
            cmdDetail: 'build failed',
          },
        };
      }

      const res = await live.sendCommand({
        type: 'exec_csharp',
        dllPath: build.dllPath,
      });
      return {
        content: [
          {
            type: 'text',
            text: res.ok
              ? `Action ran in-game. Result: ${res.detail}`
              : `Action THREW in-game:\n${res.detail}`,
          },
        ],
        details: {
          buildOk: true,
          assemblyName: build.assemblyName,
          cmdOk: res.ok,
          cmdDetail: res.detail,
        },
      };
    },
  };
}
