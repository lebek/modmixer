import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { getRegistry, getSessionManager } from '../registry/index.js';

const Params = Type.Object({
  packageIds: Type.Array(Type.String(), {
    description:
      "Ordered list of lowercased packageIds. Replaces RimWorld's <activeMods> entirely. Order is the load order. Pass an empty list to deactivate every mod (rarely useful).",
  }),
});

interface SetActiveModsResult {
  before: string[];
  after: string[];
  added: string[];
  removed: string[];
  reordered: boolean;
}

export const setActiveModsTool: AgentTool<typeof Params, SetActiveModsResult> = {
  name: 'set_active_mods',
  label: 'Replace active mod list',
  description:
    "Bulk-replace ModsConfig.xml's <activeMods> with the given ordered list. Use this for autosort, fix-session iteration, or any time you'd otherwise call enable_mod_in_game/disable_mod_in_game many times in a row. Inside an active fix session this runs without confirmation; outside one, the user must approve. RimWorld must be closed.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<SetActiveModsResult>> {
    const registry = getRegistry();
    await registry.start();
    await registry.refresh();
    const before = registry.getSnapshot().activeOrder.slice();
    const next = params.packageIds.map((p) => p.toLowerCase());
    await registry.setActiveMods(next);
    const after = registry.getSnapshot().activeOrder.slice();
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const added = after.filter((p) => !beforeSet.has(p));
    const removed = before.filter((p) => !afterSet.has(p));
    const intersection = before.filter((p) => afterSet.has(p));
    const intersectionInAfter = after.filter((p) => beforeSet.has(p));
    let reordered = false;
    for (let i = 0; i < intersection.length; i++) {
      if (intersection[i] !== intersectionInAfter[i]) {
        reordered = true;
        break;
      }
    }
    const session = getSessionManager().getActive();
    const summary =
      `Active mod list updated. ${added.length} added, ${removed.length} removed${reordered ? ', order changed' : ''}.` +
      (session
        ? ` (Inside ${session.type} session — call apply_session or revert_session when done.)`
        : '');
    return {
      content: [{ type: 'text', text: summary }],
      details: { before, after, added, removed, reordered },
    };
  },
};
