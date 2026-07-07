/**
 * RimWorld test-in-game cycle: is-running → quit? → prepare Prefs.xml → ship →
 * launch (Steam, -quicktest, isolated savedata) → arm the bridge monitor.
 * Extracted out of tools/run-test-cycle.ts so the tool is a thin dispatch to
 * getAdapter(game).test(ctx). The host callbacks (startMonitoring) arrive via
 * `ctx` so this module never imports agent-host.ts (avoids an import cycle).
 */
import { Type, type Static } from 'typebox';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import { isRimWorldRunning, quitRimWorld } from './game.js';
import { prepareDebugSession } from './prefs.js';
import { shipAndLaunch } from './ship.js';
import { ensureTestSavedataPrefs } from './test-savedata.js';
import type { RunTestCycleDetails, TestCycleContext } from '../adapters/types.js';

/**
 * RimWorld's run_test_cycle parameters. Owned here (next to the consumer) and
 * surfaced as the tool's schema via the adapter, so only a RimWorld chat's model
 * sees these debug-session knobs.
 */
export const rimworldTestCycleParams = Type.Object({
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

export type RimworldTestParams = Static<typeof rimworldTestCycleParams>;

export async function runRimworldTestCycle(
  ctx: TestCycleContext,
): Promise<AgentToolResult<RunTestCycleDetails>> {
  const p = ctx.params as RimworldTestParams;
  const lines: string[] = [];

  // 1. RimWorld-running guard. Always force-quit a running instance before
  //    relaunching — no confirmation. Modmixer users are mod-testing, so
  //    there's no save worth preserving. (Whether we launch at all is gated
  //    upstream by the user's launch-mode setting, not here.) The two early
  //    returns below are genuine failures, not consent.
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
        details: { quit: quitResult, watching: false },
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
        details: { quit: quitResult, watching: false },
      };
    }
    lines.push('Quit running RimWorld instance.');
  }

  // 2. Prep Prefs.xml — dev mode + palette pins. In isolated mode (the
  //    default) RimWorld reads Prefs from the test savedata dir, not the
  //    user's real install, so we seed the test Prefs.xml from real on first
  //    run and target IT for the edit. Without this, the dev palette
  //    auto-opens (carried over from a previous seed) but is empty because the
  //    freshly-pinned entries went to the wrong file.
  const isolated = p.isolated !== false;
  let prefsPath: string | undefined;
  if (isolated) {
    const seeded = await ensureTestSavedataPrefs();
    prefsPath = seeded ?? undefined;
  }
  const prefs = await prepareDebugSession({
    paletteEntries: p.paletteEntries,
    autoOpenPalette: p.autoOpenPalette,
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
      parts.push(
        'Enabled run-in-background so the game keeps ticking when you alt-tab.',
      );
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
    folder: ctx.folder,
    quicktest: p.quicktest,
    isolated: p.isolated,
    companionMods: p.companionMods,
  });
  if (launchResult.text) lines.push(launchResult.text);

  // 4. Arm the background bridge monitor tied to this conversation. Returns
  //    immediately; errors flow back as auto-prompted user messages over the
  //    localhost TCP bridge that shipAndLaunch just installed. startMonitoring
  //    throws if another mod is already mid-test — we let that propagate as an
  //    error tool result.
  await ctx.startMonitoring({
    conversationId: ctx.conversationId,
    modFolder: ctx.folder,
    isolated: launchResult.details.isolated,
  });
  lines.push(
    'Watching the in-game bridge in the background; errors will arrive as auto-prompts.',
  );

  return {
    content: [{ type: 'text', text: lines.join(' ') }],
    details: { quit: quitResult, watching: true },
  };
}
