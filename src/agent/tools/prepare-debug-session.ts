import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import {
  prepareDebugSession,
  type PrepareDebugSessionResult,
} from '../prefs.js';

const Params = Type.Object({
  paletteEntries: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Debug action palette entries to pin. Format is 'Category\\\\Action Name' with a single backslash separator (e.g. 'Actions\\\\Do incident\\\\STK_EmissionIncident' to pin the auto-generated 'Do incident' entry for an IncidentDef named STK_EmissionIncident, or 'ModMixer\\\\Test FooMod' for a custom [DebugAction] you've added). Existing entries are kept; duplicates are no-ops. Pass an empty array (or omit) to skip palette pinning and only flip dev mode.",
    }),
  ),
  autoOpenPalette: Type.Optional(
    Type.Boolean({
      description:
        'When true (default), the debug action palette is visible the moment the user lands in-game — they do not have to hit the bug icon to open it. Set to false to leave the palette closed at startup.',
    }),
  ),
});

export const prepareDebugSessionTool: AgentTool<
  typeof Params,
  PrepareDebugSessionResult
> = {
  name: 'prepare_debug_session',
  label: 'Prepare debug session',
  description:
    "Edit RimWorld's Prefs.xml to enable dev mode, auto-open the debug action palette on startup, and pin specific palette entries so they're one click away in-game. Run this in the test-in-game flow EVERY time, even with no entries to pin — flipping dev mode on gets the user the inspector, debug menu, and palette button regardless. When there's a clean one-click trigger (e.g. 'Actions\\\\Do incident\\\\<YourIncidentDef>' for an IncidentDef), pin it and the user can fire the new behavior without spinning up a colony. When there isn't one (UI mod, passive effect), pass autoOpenPalette=false so the palette doesn't pop up empty. RimWorld must be CLOSED when this runs (the game rewrites Prefs.xml on quit). Run BEFORE ship_and_launch so the prefs are in place when RimWorld starts. If Prefs.xml doesn't exist yet (RimWorld never launched on this machine), the tool returns skipped=true — proceed with ship_and_launch anyway and rerun after the user has quit the game once.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<PrepareDebugSessionResult>> {
    const result = await prepareDebugSession({
      paletteEntries: params.paletteEntries,
      autoOpenPalette: params.autoOpenPalette,
    });
    if (result.skipped) {
      return {
        content: [
          {
            type: 'text',
            text: `Skipped: ${result.skipReason} Continue with ship_and_launch — dev mode will be off this run; rerun prepare_debug_session after the user closes the game once.`,
          },
        ],
        details: result,
      };
    }
    const parts: string[] = [];
    parts.push(
      result.devModeWasOn
        ? 'Dev mode was already on.'
        : 'Enabled dev mode.',
    );
    parts.push(
      result.autoOpenPaletteWasOn
        ? 'Debug palette already auto-opens on launch.'
        : 'Debug palette will auto-open on launch.',
    );
    if (result.pinnedNew.length > 0) {
      parts.push(`Pinned ${result.pinnedNew.length} new palette ${result.pinnedNew.length === 1 ? 'entry' : 'entries'}: ${result.pinnedNew.join(', ')}.`);
    }
    if (result.pinnedAlready.length > 0) {
      parts.push(`Already pinned: ${result.pinnedAlready.join(', ')}.`);
    }
    return {
      content: [{ type: 'text', text: parts.join(' ') }],
      details: result,
    };
  },
};
