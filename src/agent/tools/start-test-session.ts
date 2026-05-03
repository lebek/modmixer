import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import {
  computeTestSet,
  getCommunityRules,
  getRegistry,
  getSessionManager,
} from '../registry/index.js';
import { getWorkspaceMod } from '../workspace.js';

const Params = Type.Object({
  folder: Type.String({
    description: 'Workspace mod folder name to test in isolation.',
  }),
});

interface TestSessionResult {
  sessionId: string;
  folder: string;
  packageId: string;
  reducedActive: string[];
  missing: string[];
}

export const startTestSessionTool: AgentTool<typeof Params, TestSessionResult> = {
  name: 'start_test_session',
  label: 'Start isolated test session',
  description:
    "Snapshot ModsConfig.xml, then write a minimal active list of just Core + currently-active DLCs + the target workspace mod + its transitive dependencies. The user's full mod list is preserved on disk and restored on apply_session/revert_session. Pair with sync_to_game (if not already synced) and launch_rimworld for an isolated test cycle. RimWorld must be closed.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<TestSessionResult>> {
    const mod = await getWorkspaceMod(params.folder);
    if (!mod) {
      throw new Error(`Workspace mod not found: ${params.folder}`);
    }
    if (!mod.about.packageId) {
      throw new Error(
        `Workspace mod ${params.folder} has no <packageId> in About.xml. Set one before testing.`,
      );
    }
    const registry = getRegistry();
    await registry.start();
    await registry.refresh();
    const snapshot = registry.getSnapshot();
    const rules = (await getCommunityRules()).byPackageId;
    const testSet = computeTestSet({
      snapshot,
      targetPackageId: mod.about.packageId.toLowerCase(),
      rules,
    });
    const session = await getSessionManager().startTestSession({
      folder: params.folder,
      packageId: mod.about.packageId.toLowerCase(),
      reducedActive: testSet.reducedActive,
    });
    const missingNote =
      testSet.missing.length > 0
        ? ` Missing deps not on disk: ${testSet.missing.join(', ')}.`
        : '';
    return {
      content: [
        {
          type: 'text',
          text: `Test session started for ${params.folder}. Active list reduced to ${testSet.reducedActive.length} mods (Core+DLCs+target+deps).${missingNote} Call apply_session or revert_session to end.`,
        },
      ],
      details: {
        sessionId: session.id,
        folder: params.folder,
        packageId: mod.about.packageId.toLowerCase(),
        reducedActive: testSet.reducedActive,
        missing: testSet.missing,
      },
    };
  },
};
