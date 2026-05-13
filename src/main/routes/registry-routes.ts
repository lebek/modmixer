import {
  autosort,
  computeTestSet,
  diffActiveLists,
  getCommunityRules,
  getRegistry,
  getSessionManager,
  refreshCommunityRules,
  type RegistryMod,
} from '../../agent/registry/index.js';
import type { RouteContext } from './context.js';

/**
 * Mod registry (the unified DLC + local + workshop + workspace view) and
 * the snapshot-restore session machinery layered on top of it.
 */
export function registerRegistryRoutes(ctx: RouteContext): void {
  const { ipc, buildRegistryEnvelope } = ctx;
  const registry = getRegistry();
  const sessions = getSessionManager();

  ipc.handle('modmixer:registry:get', async () => {
    await registry.refresh();
    return buildRegistryEnvelope();
  });

  ipc.handle('modmixer:registry:refresh', async () => {
    await registry.refresh();
    return buildRegistryEnvelope();
  });

  ipc.handle(
    'modmixer:registry:set-active',
    async (_evt, packageIds: string[]) => {
      await registry.setActiveMods(packageIds);
      return buildRegistryEnvelope();
    },
  );

  ipc.handle('modmixer:registry:autosort', async () => {
    const snapshot = registry.getSnapshot();
    const rules = await getCommunityRules();
    return autosort({
      activeOrder: snapshot.activeOrder,
      snapshot,
      rules: rules.byPackageId,
    });
  });

  ipc.handle('modmixer:registry:apply-autosort', async () => {
    const snapshot = registry.getSnapshot();
    const rules = await getCommunityRules();
    const result = autosort({
      activeOrder: snapshot.activeOrder,
      snapshot,
      rules: rules.byPackageId,
    });
    await registry.setActiveMods(result.order);
    return { envelope: buildRegistryEnvelope(), conflicts: result.conflicts };
  });

  // Add a mod to <activeMods> together with its installed transitive deps,
  // then autosort. Mirrors what `shipAndLaunch` does so the UI's "enable"
  // and "+deps" actions can't drift from the test-cycle flow. Returns the
  // new envelope plus a summary of what changed for banner display.
  ipc.handle(
    'modmixer:registry:enable-with-deps',
    async (_evt, packageId: string) => {
      const target = packageId.toLowerCase();
      await registry.refresh();
      const snapshot = registry.getSnapshot();
      const before = snapshot.activeOrder.slice();
      const beforeSet = new Set(before);

      const installedByPid = new Map<string, RegistryMod>();
      for (const m of snapshot.mods) {
        if (m.about.packageIdLc) installedByPid.set(m.about.packageIdLc, m);
      }

      const closure = new Set<string>();
      const missingDeps = new Set<string>();
      const queue: string[] = [target];
      const visited = new Set<string>();
      while (queue.length > 0) {
        const pid = queue.shift()!;
        if (visited.has(pid)) continue;
        visited.add(pid);
        const m = installedByPid.get(pid);
        if (!m) continue;
        for (const dep of m.about.modDependencies) {
          const depPid = dep.packageIdLc;
          if (!depPid) continue;
          if (installedByPid.has(depPid)) {
            closure.add(depPid);
            queue.push(depPid);
          } else {
            missingDeps.add(dep.displayName || depPid);
          }
        }
      }

      const desired = before.slice();
      const added: string[] = [];
      const alreadyActive = beforeSet.has(target);
      if (!alreadyActive && installedByPid.has(target)) {
        desired.push(target);
        added.push(target);
      }
      for (const dep of closure) {
        if (!beforeSet.has(dep)) {
          desired.push(dep);
          added.push(dep);
        }
      }

      const rules = await getCommunityRules();
      const sorted = autosort({
        activeOrder: desired,
        snapshot,
        rules: rules.byPackageId,
      });

      const changed =
        sorted.order.length !== before.length ||
        sorted.order.some((p, i) => p !== before[i]);
      if (changed) {
        await registry.setActiveMods(sorted.order);
      }

      return {
        envelope: buildRegistryEnvelope(),
        added,
        missing: Array.from(missingDeps),
        alreadyActive,
        conflicts: sorted.conflicts,
      };
    },
  );

  ipc.handle('modmixer:registry:community-rules', async () => {
    const snap = await getCommunityRules();
    // Maps don't always cross IPC happily depending on Electron settings —
    // serialize to a plain object for the renderer.
    const rules: Record<string, unknown> = {};
    for (const [k, v] of snap.byPackageId) rules[k] = v;
    return {
      fetchedAt: snap.fetchedAt,
      source: snap.source,
      count: snap.byPackageId.size,
      rules,
    };
  });

  ipc.handle('modmixer:registry:refresh-community-rules', async () => {
    const snap = await refreshCommunityRules();
    return {
      fetchedAt: snap.fetchedAt,
      source: snap.source,
      count: snap.byPackageId.size,
    };
  });

  // Sessions: snapshot-restore primitive used by Test Mode and Fix Mode.
  ipc.handle('modmixer:session:get-active', () => sessions.getActive());

  ipc.handle(
    'modmixer:session:start-test',
    async (_evt, args: { folder: string; packageId: string }) => {
      const snapshot = registry.getSnapshot();
      const rules = (await getCommunityRules()).byPackageId;
      const testSet = computeTestSet({
        snapshot,
        targetPackageId: args.packageId.toLowerCase(),
        rules,
      });
      const session = await sessions.startTestSession({
        folder: args.folder,
        packageId: args.packageId.toLowerCase(),
        reducedActive: testSet.reducedActive,
      });
      return { session, testSet, envelope: buildRegistryEnvelope() };
    },
  );

  ipc.handle('modmixer:session:start-fix', async () => {
    const snapshot = registry.getSnapshot();
    const session = await sessions.startFixSession(snapshot.activeOrder);
    return { session, envelope: buildRegistryEnvelope() };
  });

  ipc.handle('modmixer:session:apply', async () => {
    await sessions.apply();
    return { envelope: buildRegistryEnvelope() };
  });

  ipc.handle('modmixer:session:revert', async () => {
    await sessions.revert();
    await registry.refresh();
    return { envelope: buildRegistryEnvelope() };
  });

  ipc.handle('modmixer:session:diff', () => {
    const session = sessions.getActive();
    if (!session) return null;
    const initial = session.initialActive ?? [];
    const current = registry.getSnapshot().activeOrder;
    return diffActiveLists(initial, current);
  });
}
