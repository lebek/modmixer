import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import {
  autosort,
  getCommunityRules,
  getRegistry,
} from '../registry/index.js';

const Params = Type.Object({
  apply: Type.Optional(
    Type.Boolean({
      description:
        "If true, write the sorted order to ModsConfig.xml. If false, return the proposed order without modifying anything (preview mode). Default false. Inside a fix session, prefer apply=true since the session itself owns the can-revert promise.",
    }),
  ),
});

interface AutosortResult {
  before: string[];
  after: string[];
  changed: boolean;
  conflicts: { source: string; kind: string; declaredBy: string; other: string }[];
  applied: boolean;
}

export const autosortModsTool: AgentTool<typeof Params, AutosortResult> = {
  name: 'autosort_mods',
  label: 'Autosort active mod list',
  description:
    "Compute a load order that respects About.xml dependencies (hard) plus the RimSort Community Rules DB (soft preferences for known cross-mod ordering). Core/DLCs stay first. Returns the proposed order. Pass apply=true to actually write ModsConfig.xml, otherwise returns a preview only. Conflicts (constraints we couldn't satisfy without creating a cycle) are surfaced for review.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<AutosortResult>> {
    const registry = getRegistry();
    await registry.start();
    await registry.refresh();
    const before = registry.getSnapshot().activeOrder.slice();
    const rules = await getCommunityRules();
    const result = autosort({
      activeOrder: before,
      snapshot: registry.getSnapshot(),
      rules: rules.byPackageId,
    });
    const apply = !!params.apply;
    const changed =
      before.length !== result.order.length ||
      before.some((p, i) => p !== result.order[i]);
    if (apply && changed) {
      await registry.setActiveMods(result.order);
    }
    const conflicts = result.conflicts.map((c) => ({
      source: c.source,
      kind: c.kind,
      declaredBy: c.declaredBy,
      other: c.other,
    }));
    const summary = apply
      ? changed
        ? `Applied autosort. ${conflicts.length} unsatisfiable constraints.`
        : `Already sorted; nothing to apply.`
      : changed
      ? `Preview generated. ${result.order.length} mods, ${conflicts.length} unsatisfiable constraints. Re-run with apply=true to write.`
      : `Already sorted; no changes proposed.`;
    return {
      content: [{ type: 'text', text: summary }],
      details: {
        before,
        after: result.order,
        changed,
        conflicts,
        applied: apply && changed,
      },
    };
  },
};
