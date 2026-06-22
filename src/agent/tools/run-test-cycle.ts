import { Type } from 'typebox';
import path from 'node:path';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { isRimWorldRunning, quitRimWorld } from '../game.js';
import { prepareDebugSession } from '../prefs.js';
import { shipAndLaunch, type ShipAndLaunchDetails } from '../ship.js';
import { ensureTestSavedataPrefs } from '../test-savedata.js';
import { getAgentHost } from '../agent-host.js';
import { readModPrefs } from '../mod-prefs.js';
import { getWorkspacePaths } from '../workspace.js';
import {
  isMinecraftClientRunning,
  quitMinecraftClient,
  launchMinecraftClient,
} from '../minecraft/launch.js';

const Params = Type.Object({
  folder: Type.String({
    description: 'Workspace mod folder name to ship and launch.',
  }),
  paletteEntries: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Debug action palette entries to pin. Format is 'Category\\\\Action Name' with a single backslash separator (e.g. 'Actions\\\\Do incident\\\\STK_EmissionIncident'). Existing entries are kept.",
    }),
  ),
  autoOpenPalette: Type.Optional(
    Type.Boolean({
      description:
        'When true (default), the debug action palette opens on game load. Set to false for UI mods or passive effects with no palette trigger.',
    }),
  ),
  quicktest: Type.Optional(
    Type.Boolean({
      description:
        'Default true. Pass `-quicktest` so RimWorld bypasses the main menu and lands the user directly in a generated map. Set false ONLY when the test needs the menus (ScenarioDef picker, custom main-menu UI, mod options, save-load flows).',
    }),
  ),
  isolated: Type.Optional(
    Type.Boolean({
      description:
        "Default true. Launch with `-savedatafolder=<modmixer-test-dir>` so the test session reads/writes a separate ModsConfig.xml — the user's real mod list is untouched. Set false to mutate the user's real list (use only when the test needs their other mods loaded).",
    }),
  ),
  companionMods: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "PackageIds of already-installed mods to load alongside the target in the isolated test session. Use this for compat testing — e.g. when the mod was built to patch or interoperate with another installed mod the user has. Their transitive dependencies are pulled in and autosorted automatically. Get packageIds from `list_installed_mods`. Ignored in non-isolated mode, where the user's real mod list already loads everything.",
    }),
  ),
});

interface RunTestCycleDetails {
  /** Whether the running RimWorld was force-quit and whether it actually exited. */
  quit: { wasRunning: boolean; killed: boolean; exited: boolean } | null;
  /** Prefs.xml mutation result; null when Prefs.xml doesn't exist yet. */
  prefs: {
    skipped: boolean;
    skipReason: string | null;
    pinnedNew: string[];
    pinnedAlready: string[];
  } | null;
  /** Sync + launch result; null when we bailed before launching. */
  launch: ShipAndLaunchDetails | null;
  /** True when background bridge monitoring was armed. */
  watching: boolean;
}

/**
 * Single-call macro for the test-in-game flow. Bundles the entire
 * is-running → quit? → prepare-prefs → ship → launch → watch chain so the
 * agent doesn't have to orchestrate it turn-by-turn.
 *
 * Quit handling: if RimWorld is already running, the macro force-quits it
 * and relaunches — no confirmation. Modmixer users are mod-testing, so there
 * is no save worth preserving; asking would just add friction. Whether a
 * launch happens at all is governed upstream by the user's launch-mode
 * setting (baked into the system prompt), not here.
 *
 * Built per conversation: `conversationId` is captured so the background
 * bridge monitor this arms is bound to the chat that launched the test,
 * even when several mod tabs are open at once. Only one in-game test can
 * run at a time — startMonitoring throws if another mod is mid-test, and
 * that error propagates back to the agent as a tool result.
 */
/**
 * Minecraft test cycle: arm the shared bridge monitor, then launch the modded
 * client with `gradlew runClient` (the bridge mod streams aggregated errors
 * back over localhost). Fire-and-forget — the client runs until it auto-exits
 * (watchdog) or the user closes it; errors arrive as auto-prompts meanwhile.
 */
async function runMinecraftTestCycle(
  conversationId: string,
  folder: string,
): Promise<AgentToolResult<RunTestCycleDetails>> {
  const lines: string[] = [];

  let quit: RunTestCycleDetails['quit'] = null;
  if (isMinecraftClientRunning()) {
    await quitMinecraftClient();
    quit = { wasRunning: true, killed: true, exited: true };
    lines.push('Stopped the previous test client.');
  }

  // Arm the monitor BEFORE launching so the bridge can connect as the client
  // boots (the bridge also retries with backoff, so order is forgiving).
  await getAgentHost().startMonitoring({
    conversationId,
    modFolder: folder,
    isolated: false,
  });

  const { workspaceDir } = getWorkspacePaths();
  const projectDir = path.join(workspaceDir, folder);
  try {
    await launchMinecraftClient(projectDir);
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Failed to launch the Minecraft client: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ],
      details: { quit, prefs: null, launch: null, watching: false },
    };
  }

  lines.push(
    'Launched the modded client (gradlew runClient) with the diagnostics bridge. ' +
      'The first run decompiles Minecraft and can take several minutes. Errors will ' +
      'arrive automatically as "[automated …]" messages; tell the user what to try in-game.',
  );
  return {
    content: [{ type: 'text', text: lines.join(' ') }],
    details: { quit, prefs: null, launch: null, watching: true },
  };
}

export function createRunTestCycleTool(
  conversationId: string,
): AgentTool<typeof Params, RunTestCycleDetails> {
  return {
    name: 'run_test_cycle',
    label: 'Run test cycle (build + launch + watch)',
    description:
      "Macro: the only way to test a mod in-game. Handles the entire flow in one call — flips dev-mode + pins palette entries in Prefs.xml, syncs the mod into RimWorld's Mods/, installs the Modmixer Bridge mod (Harmony-patched diagnostics over localhost TCP), writes an active-mod list (Core + DLCs + target + transitive deps + any companionMods + bridge) to a separate savedata folder by default so the user's real mod list is untouched, launches RimWorld with `-quicktest`, and arms background bridge monitoring. If RimWorld is already running it's force-quit and relaunched automatically — never ask about unsaved progress (Modmixer users are mod-testing; saves don't matter). After this returns, tell the user EXACTLY what to do in-game (they're about to alt-tab) — errors will arrive automatically as '[automated …]' messages via the standard error-triage protocol.",
    parameters: Params,
    async execute(_id, params): Promise<AgentToolResult<RunTestCycleDetails>> {
      // Minecraft mods take a completely different test path: no Steam, no
      // ModsConfig, no Prefs — launch the modded client straight from the
      // project via `gradlew runClient` with the bridge mod loaded. The
      // monitor server + error-buffer plumbing is shared.
      const modPrefs = await readModPrefs(params.folder);
      if (modPrefs.game === 'minecraft') {
        return runMinecraftTestCycle(conversationId, params.folder);
      }

      const lines: string[] = [];

      // 1. RimWorld-running guard. Always force-quit a running instance before
      //    relaunching — no confirmation. Modmixer users are mod-testing, so
      //    there's no save worth preserving. (Whether we launch at all is
      //    gated upstream by the user's launch-mode setting, not here.) The
      //    two early returns below are genuine failures, not consent.
      let quitResult: RunTestCycleDetails['quit'] = null;
      if (await isRimWorldRunning()) {
        const { killed, exited } = await quitRimWorld();
        quitResult = { wasRunning: true, killed, exited };
        if (!killed) {
          return {
            content: [
              {
                type: 'text',
                text: 'Failed to quit RimWorld — try quitting it manually and retry.',
              },
            ],
            details: {
              quit: quitResult,
              prefs: null,
              launch: null,
              watching: false,
            },
          };
        }
        if (!exited) {
          return {
            content: [
              {
                type: 'text',
                text: 'Sent quit signal but RimWorld is still running after 10s. Wait, then retry.',
              },
            ],
            details: {
              quit: quitResult,
              prefs: null,
              launch: null,
              watching: false,
            },
          };
        }
        lines.push('Quit running RimWorld instance.');
      }

      // 2. Prep Prefs.xml — dev mode + palette pins. In isolated mode (the
      //    default) RimWorld reads Prefs from the test savedata dir, not the
      //    user's real install, so we seed the test Prefs.xml from real on
      //    first run and target IT for the edit. Without this, the dev palette
      //    auto-opens (carried over from a previous seed) but is empty because
      //    the freshly-pinned entries went to the wrong file.
      const isolated = params.isolated !== false;
      let prefsPath: string | undefined;
      if (isolated) {
        const seeded = await ensureTestSavedataPrefs();
        prefsPath = seeded ?? undefined;
      }
      const prefs = await prepareDebugSession({
        paletteEntries: params.paletteEntries,
        autoOpenPalette: params.autoOpenPalette,
        prefsPath,
      });
      if (prefs.skipped) {
        lines.push(
          `Prefs.xml not found yet (${prefs.skipReason}); dev mode will engage on next run.`,
        );
      } else {
        const parts: string[] = [];
        parts.push(prefs.devModeWasOn ? 'Dev mode on.' : 'Enabled dev mode.');
        parts.push(
          prefs.autoOpenPaletteWasOn
            ? 'Debug palette already auto-opens.'
            : 'Debug palette will auto-open.',
        );
        if (!prefs.runInBackgroundWasOn) {
          parts.push('Enabled run-in-background so the game keeps ticking when you alt-tab.');
        }
        if (prefs.pinnedNew.length > 0) {
          parts.push(
            `Pinned ${prefs.pinnedNew.length} palette ${prefs.pinnedNew.length === 1 ? 'entry' : 'entries'}: ${prefs.pinnedNew.join(', ')}.`,
          );
        }
        if (prefs.pinnedAlready.length > 0) {
          parts.push(`Already pinned: ${prefs.pinnedAlready.join(', ')}.`);
        }
        lines.push(parts.join(' '));
      }

      // 3. Sync + launch — isolated savedata, autosort, dep walk, missing-dep
      //    surfacing. Throws on is-running races; we let that propagate.
      const launchResult = await shipAndLaunch({
        folder: params.folder,
        quicktest: params.quicktest,
        isolated: params.isolated,
        companionMods: params.companionMods,
      });
      if (launchResult.text) lines.push(launchResult.text);

      // 4. Arm the background bridge monitor tied to this conversation.
      //    Returns immediately; errors flow back as auto-prompted user messages
      //    over the localhost TCP bridge that run_test_cycle just installed.
      //    startMonitoring throws if another mod is already mid-test — we let
      //    that propagate as an error tool result.
      await getAgentHost().startMonitoring({
        conversationId,
        modFolder: params.folder,
        isolated: launchResult.details.isolated,
      });
      lines.push(
        'Watching the in-game bridge in the background; errors will arrive as auto-prompts.',
      );

      return {
        content: [{ type: 'text', text: lines.join(' ') }],
        details: {
          quit: quitResult,
          prefs: {
            skipped: prefs.skipped,
            skipReason: prefs.skipReason,
            pinnedNew: prefs.skipped ? [] : prefs.pinnedNew,
            pinnedAlready: prefs.skipped ? [] : prefs.pinnedAlready,
          },
          launch: launchResult.details,
          watching: true,
        },
      };
    },
  };
}
