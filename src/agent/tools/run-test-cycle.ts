import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { getAgentHost } from '../agent-host.js';
import { readModPrefs } from '../mod-prefs.js';
import { getAdapter } from '../adapters/index.js';
import type {
  RunTestCycleDetails,
  TestCycleContext,
} from '../adapters/types.js';
import type { GameId } from '../games/types.js';

export type { RunTestCycleDetails };

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

/**
 * Single-call macro for the test-in-game flow. Per-game behavior lives in the
 * adapter (RimWorld → ship/launch via Steam + ModsConfig; Minecraft → gradlew
 * runClient). The macro stays thin: read the mod's game, build the test
 * context, dispatch.
 *
 * Built per conversation: `conversationId` is captured so the background bridge
 * monitor the cycle arms is bound to the chat that launched the test, even when
 * several mod tabs are open at once. The host callbacks (startMonitoring /
 * reportTestDiagnostic) are injected into the context here — that's why the
 * adapters never import agent-host.ts (avoids an import cycle).
 */
export function createRunTestCycleTool(
  conversationId: string,
  game: GameId = 'rimworld',
): AgentTool<typeof Params, RunTestCycleDetails> {
  return {
    name: 'run_test_cycle',
    label: 'Run test cycle (build + launch + watch)',
    description:
      game === 'minecraft'
        ? "Macro: the only way to test the mod in-game. Builds the mod if needed and launches the modded client (./gradlew runClient) with the diagnostics bridge (aggregated, deduped errors streamed back over localhost), then arms background monitoring. The first run decompiles Minecraft and can take several minutes — that's expected, not a hang. If a client is already running it's stopped and relaunched. After this returns, tell the user EXACTLY what to try in-game (they're about to alt-tab) — errors arrive automatically as '[automated …]' messages via the error-triage protocol. Just pass `folder`; the paletteEntries/autoOpenPalette/quicktest/isolated/companionMods options are RimWorld-only and ignored here."
        : "Macro: the only way to test a mod in-game. Handles the entire flow in one call — flips dev-mode + pins palette entries in Prefs.xml, syncs the mod into RimWorld's Mods/, installs the Modmixer Bridge mod (Harmony-patched diagnostics over localhost TCP), writes an active-mod list (Core + DLCs + target + transitive deps + any companionMods + bridge) to a separate savedata folder by default so the user's real mod list is untouched, launches RimWorld with `-quicktest`, and arms background bridge monitoring. If RimWorld is already running it's force-quit and relaunched automatically — never ask about unsaved progress (Modmixer users are mod-testing; saves don't matter). After this returns, tell the user EXACTLY what to do in-game (they're about to alt-tab) — errors will arrive automatically as '[automated …]' messages via the standard error-triage protocol.",
    parameters: Params,
    async execute(_id, params): Promise<AgentToolResult<RunTestCycleDetails>> {
      const prefs = await readModPrefs(params.folder);
      const ctx: TestCycleContext = {
        conversationId,
        folder: params.folder,
        paletteEntries: params.paletteEntries,
        autoOpenPalette: params.autoOpenPalette,
        quicktest: params.quicktest,
        isolated: params.isolated,
        companionMods: params.companionMods,
        startMonitoring: (args) => getAgentHost().startMonitoring(args),
        reportTestDiagnostic: (cid, message) =>
          getAgentHost().reportTestDiagnostic(cid, message),
      };
      return getAdapter(prefs.game).test(ctx);
    },
  };
}
