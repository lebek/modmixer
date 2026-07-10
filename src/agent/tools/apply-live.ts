import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { getLiveServer } from '../live/server.js';
import { buildHotAssembly } from '../live/build.js';
import { extractHints, formatHints } from '../build-error-hints.js';
import { getWorkspacePaths } from '../workspace.js';
import type { ConversationScope } from '../conversations.js';
import path from 'node:path';

const Params = Type.Object({
  defsOnly: Type.Optional(
    Type.Boolean({
      description:
        'Set true when ONLY def/Patches XML changed this iteration — skips the C# rebuild and just hot-reloads defs in the running game. Default false (full reconcile: rebuild, unpatch, hot-load, re-patch, reload defs).',
    }),
  ),
});

export interface ApplyLiveDetails {
  defsOnly: boolean;
  buildOk: boolean | null;
  assemblyName: string | null;
  cmdOk: boolean;
  cmdDetail: string;
}

/**
 * The live session's reconcile step: make the running game match the
 * session mod's current source. Full mode rebuilds the whole mod into a
 * fresh uniquely-named assembly, then has the in-game Live mod unpatch
 * everything this session owns, load the new assembly, re-patch, and
 * hot-reload defs — so add/remove/change all converge with no residue.
 *
 * Built per conversation so the session's Harmony id is stable across
 * iterations (that id is what UnpatchAll uses to find "our" patches).
 */
export function createApplyLiveTool(
  conversationId: string,
  getActiveScope: () => ConversationScope | null,
): AgentTool<typeof Params, ApplyLiveDetails> {
  const harmonyId = `modmixer.live.session.${conversationId}`;
  return {
    name: 'apply_live',
    label: 'Apply to running game',
    description:
      'Apply the session mod\'s CURRENT source to the running game, live — no relaunch. Rebuilds the whole mod, unloads every Harmony patch this session applied before, hot-loads the fresh assembly, re-patches, and hot-reloads def XML. After it returns, live behavior == current source (removing code removes its behavior). Use after every edit you want the player to see. Use defsOnly=true for XML-only iterations. If the game reports errors right after, they arrive as "[automated …]" messages — fix and re-apply.',
    parameters: Params,
    async execute(_id, params, signal): Promise<AgentToolResult<ApplyLiveDetails>> {
      const scope = getActiveScope();
      if (!scope || scope.type !== 'mod') {
        throw new Error('apply_live needs a mod-scoped live conversation.');
      }
      const live = getLiveServer();
      if (!live.isConnected()) {
        throw new Error(
          'No live game connected — the player may have closed RimWorld. Ask them to relaunch the live session from Modmixer.',
        );
      }

      const defsOnly = params.defsOnly === true;
      if (defsOnly) {
        const res = await live.sendCommand({ type: 'reload_defs' });
        return {
          content: [
            {
              type: 'text',
              text: res.ok
                ? `Defs hot-reloaded in the running game. ${res.detail}`
                : `Def hot-reload FAILED in-game: ${res.detail}`,
            },
          ],
          details: {
            defsOnly: true,
            buildOk: null,
            assemblyName: null,
            cmdOk: res.ok,
            cmdDetail: res.detail,
          },
        };
      }

      const build = await buildHotAssembly(scope.modFolder, signal);
      if (!build.ok || !build.dllPath) {
        // Same hint plumbing as build_mod so missing-using errors resolve
        // against the C# index without an extra tool call.
        let hints = '';
        try {
          const { workspaceDir } = getWorkspacePaths();
          hints = formatHints(
            extractHints(build.output, path.join(workspaceDir, scope.modFolder)),
          );
        } catch {
          // Hints are best-effort.
        }
        return {
          content: [
            {
              type: 'text',
              text: `BUILD FAILED — nothing was applied to the game.\n\n${build.output}${hints}`,
            },
          ],
          details: {
            defsOnly: false,
            buildOk: false,
            assemblyName: build.assemblyName || null,
            cmdOk: false,
            cmdDetail: 'build failed',
          },
        };
      }

      const res = await live.sendCommand({
        type: 'hot_load',
        dllPath: build.dllPath,
        harmonyId,
        reloadDefs: true,
      });
      const text = res.ok
        ? `Applied live (assembly ${build.assemblyName}). ${res.detail}`
        : `Build succeeded but the in-game apply FAILED: ${res.detail}\nThe previous iteration's patches were already removed — the mod may be partially active. Fix the cause and apply_live again.`;
      return {
        content: [{ type: 'text', text }],
        details: {
          defsOnly: false,
          buildOk: true,
          assemblyName: build.assemblyName,
          cmdOk: res.ok,
          cmdDetail: res.detail,
        },
      };
    },
  };
}
