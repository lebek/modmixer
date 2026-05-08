import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { isRimWorldRunning, quitRimWorld } from '../game.js';
import { prepareDebugSession } from '../prefs.js';
import { shipAndLaunchTool, type ShipAndLaunchDetails } from './ship-and-launch.js';
import { getAgentHost } from '../agent-host.js';

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
  quitIfRunning: Type.Optional(
    Type.Boolean({
      description:
        "When true, force-quit any running RimWorld process before launching. Default false: if RimWorld is running, the macro returns early so the agent can ask the user (they may have unsaved progress). Re-call with quitIfRunning=true after explicit user confirmation.",
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
});

interface RunTestCycleDetails {
  /** True when the macro had to bail because RimWorld was running and quitIfRunning was not set. */
  needsQuitConfirmation: boolean;
  /** Whether quit_rimworld was called and whether it succeeded. */
  quit: { wasRunning: boolean; killed: boolean; exited: boolean } | null;
  /** prepare_debug_session result; null when Prefs.xml doesn't exist yet. */
  prefs: {
    skipped: boolean;
    skipReason: string | null;
    pinnedNew: string[];
    pinnedAlready: string[];
  } | null;
  /** ship_and_launch result; null when we bailed before launching. */
  launch: ShipAndLaunchDetails | null;
  /** True when background log monitoring was armed. */
  watching: boolean;
}

/**
 * Single-call macro for the test-in-game flow. Replaces the 5-step sequence
 * (is_rimworld_running → quit_rimworld? → prepare_debug_session →
 * ship_and_launch → watch_player_log) the agent used to run by hand on every
 * test cycle.
 *
 * Saves four round-trips per test launch (each one paying full input-token
 * cost on the growing context) and removes the corresponding 7-step runbook
 * from the system prompt — see system-prompt.ts.
 *
 * Quit guarding: if RimWorld is running, the macro bails with
 * needsQuitConfirmation=true UNLESS the caller passed quitIfRunning=true.
 * The agent is expected to ask the user before destroying their unsaved
 * game progress; a "yes" round-trip + retry with quitIfRunning=true keeps
 * that consent boundary explicit.
 */
export const runTestCycleTool: AgentTool<typeof Params, RunTestCycleDetails> = {
  name: 'run_test_cycle',
  label: 'Run test cycle (build + launch + watch)',
  description:
    "Macro: handle the entire test-in-game flow in one call. Runs is_rimworld_running, prepare_debug_session (dev mode + palette pins), ship_and_launch (sync to game + isolated savedata + -quicktest), and arms watch_player_log for background error monitoring. If RimWorld is running and quitIfRunning is unset, bails with needsQuitConfirmation=true so you can ask the user before killing their game; re-call with quitIfRunning=true once they confirm. After this returns, tell the user EXACTLY what to do in-game (they're about to alt-tab) — errors will arrive automatically as '[automated …]' messages via the standard error-triage protocol.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<RunTestCycleDetails>> {
    const lines: string[] = [];

    // 1. RimWorld-running guard. If running and the user hasn't authorized a
    //    quit, bail with a clear message so the agent asks first instead of
    //    silently destroying the user's session.
    let quitResult: RunTestCycleDetails['quit'] = null;
    if (await isRimWorldRunning()) {
      if (!params.quitIfRunning) {
        return {
          content: [
            {
              type: 'text',
              text: 'RimWorld is currently running. Ask the user whether to quit it (they may have unsaved progress), then re-call run_test_cycle with quitIfRunning=true.',
            },
          ],
          details: {
            needsQuitConfirmation: true,
            quit: null,
            prefs: null,
            launch: null,
            watching: false,
          },
        };
      }
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
            needsQuitConfirmation: false,
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
            needsQuitConfirmation: false,
            quit: quitResult,
            prefs: null,
            launch: null,
            watching: false,
          },
        };
      }
      lines.push('Quit running RimWorld instance.');
    }

    // 2. prepare_debug_session — dev mode + palette pins. Tolerates missing
    //    Prefs.xml (first-ever launch); the caller proceeds either way.
    const prefs = await prepareDebugSession({
      paletteEntries: params.paletteEntries,
      autoOpenPalette: params.autoOpenPalette,
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

    // 3. ship_and_launch — delegate to the underlying tool so we inherit
    //    every behavior (isolated savedata, autosort, dep walk, missing-dep
    //    surfacing) without copying the body. The tool throws on
    //    is-running races; we let that propagate.
    const launchResult = await shipAndLaunchTool.execute(
      _id,
      {
        folder: params.folder,
        quicktest: params.quicktest,
        isolated: params.isolated,
      },
      undefined as unknown as AbortSignal,
      undefined,
    );
    const launchText = launchResult.content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .filter(Boolean)
      .join(' ');
    if (launchText) lines.push(launchText);

    // 4. watch_player_log — arm the background log watcher tied to the
    //    current conversation. Returns immediately; errors flow back as
    //    auto-prompted user messages.
    const host = getAgentHost();
    const conversationId = host.getCurrentId();
    let watching = false;
    if (conversationId) {
      host.startLogMonitoring(conversationId);
      watching = true;
      lines.push(
        'Watching Player.log in the background; errors will arrive as auto-prompts.',
      );
    } else {
      lines.push(
        'Could not arm log monitoring — no active conversation context.',
      );
    }

    return {
      content: [{ type: 'text', text: lines.join(' ') }],
      details: {
        needsQuitConfirmation: false,
        quit: quitResult,
        prefs: {
          skipped: prefs.skipped,
          skipReason: prefs.skipReason,
          pinnedNew: prefs.skipped ? [] : prefs.pinnedNew,
          pinnedAlready: prefs.skipped ? [] : prefs.pinnedAlready,
        },
        launch: launchResult.details ?? null,
        watching,
      },
    };
  },
};
