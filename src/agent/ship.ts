import { isRimWorldRunning, launchRimWorld } from './game.js';
import { syncModToGame } from './workspace.js';
import {
  autosort,
  computeTestSet,
  getCommunityRules,
  getRegistry,
  readModsConfig,
  type RegistryMod,
} from './registry/index.js';
import { buildTestSavedata } from './test-savedata.js';

export interface ShipAndLaunchOptions {
  folder: string;
  /** Default true. Pass `-quicktest`. */
  quicktest?: boolean;
  /** Default true. Launch with `-savedatafolder=<modmixer-test-dir>`. */
  isolated?: boolean;
}

export interface ShipAndLaunchDetails {
  folder: string;
  packageId: string;
  alreadyEnabled: boolean;
  /**
   * In isolated mode: the reduced active list written to the test ModsConfig.
   * In non-isolated mode: lowercased packageIds we just added to the real
   * <activeMods> (target + transitive deps).
   */
  added: string[];
  missingDeps: string[];
  reordered: boolean;
  conflicts: number;
  alreadyRunning: boolean;
  quicktest: boolean;
  isolated: boolean;
  savedataDir?: string;
}

export interface ShipAndLaunchResult {
  text: string;
  details: ShipAndLaunchDetails;
}

/**
 * Sync the mod into RimWorld's Mods/, write an active-mod list (isolated test
 * savedata by default), then launch the game. Called by `run_test_cycle`;
 * not exposed as an agent tool — direct callers should use `run_test_cycle`
 * for the full prep+launch+watch flow.
 *
 * Default mode is **isolated**: writes a reduced active list (Core +
 * currently-active DLCs + target + transitive deps) to a separate savedata
 * folder via `-savedatafolder`, leaving the user's real ModsConfig.xml
 * untouched. The reduced set is built by `computeTestSet`, which BFS-walks
 * <modDependencies> over installed mods and runs autosort on the result.
 *
 * Non-isolated mode mutates the user's real <activeMods>: walks
 * <modDependencies> transitively, adds installed deps to the live list,
 * autosorts, and refuses to run while RimWorld is open (since the game
 * rewrites ModsConfig.xml on quit).
 */
export async function shipAndLaunch(
  opts: ShipAndLaunchOptions,
): Promise<ShipAndLaunchResult> {
  const isolated = opts.isolated !== false;
  if (await isRimWorldRunning()) {
    throw new Error(
      'RimWorld is currently running. Shipping needs the game closed (the game rewrites ModsConfig on quit, and a running instance turns a re-launch into a no-op).',
    );
  }

  await syncModToGame(opts.folder);

  const registry = getRegistry();
  await registry.start();
  await registry.refresh();
  const snapshot = registry.getSnapshot();

  const targetMod = snapshot.mods.find(
    (m) => m.folder === opts.folder && m.source === 'workspace',
  );
  if (!targetMod || !targetMod.about.packageIdLc) {
    throw new Error(
      `Could not resolve packageId for workspace mod "${opts.folder}". Is About.xml present and well-formed?`,
    );
  }
  const targetPid = targetMod.about.packageIdLc;
  const alreadyEnabled = snapshot.activeOrder.includes(targetPid);
  const quicktest = opts.quicktest !== false;
  const rules = (await getCommunityRules()).byPackageId;

  if (isolated) {
    const testSet = computeTestSet({
      snapshot,
      targetPackageId: targetPid,
      rules,
    });
    // Carry over <version> and <knownExpansions> from the user's real
    // ModsConfig so DLCs the user owns stay declared in the isolated copy
    // (knownExpansions gates DLC content even though the active list also
    // lists DLC packageIds).
    const real = await readModsConfig();
    const sd = await buildTestSavedata({
      activeMods: testSet.reducedActive,
      knownExpansions: real.knownExpansions,
      version: real.version,
    });
    const launch = await launchRimWorld({
      args: quicktest ? ['-quicktest'] : [],
      savedataFolder: sd.savedataDir,
    });

    const lines: string[] = [];
    lines.push(`Synced ${opts.folder} into RimWorld's Mods/.`);
    lines.push(
      `Isolated test session: wrote ${testSet.reducedActive.length} active mods (Core+DLCs+target+deps) to ${sd.configPath}. Real ModsConfig.xml is untouched.`,
    );
    if (testSet.missing.length > 0) {
      lines.push(
        `Declared deps NOT installed (mod will fail to load until installed): ${testSet.missing.join(', ')}.`,
      );
    }
    lines.push(
      launch.alreadyRunning
        ? 'RimWorld was running again by launch time; the spawn was a no-op. Tell the user to quit and retry.'
        : `Launched RimWorld with -savedatafolder=${sd.savedataDir}${quicktest ? ' and -quicktest' : ''}.`,
    );

    return {
      text: lines.join(' '),
      details: {
        folder: opts.folder,
        packageId: targetPid,
        alreadyEnabled,
        added: testSet.reducedActive,
        missingDeps: testSet.missing,
        reordered: false,
        conflicts: 0,
        alreadyRunning: launch.alreadyRunning,
        quicktest,
        isolated: true,
        savedataDir: sd.savedataDir,
      },
    };
  }

  // Non-isolated path: mutate the user's real <activeMods>.
  const installedByPid = new Map<string, RegistryMod>();
  for (const m of snapshot.mods) {
    if (m.about.packageIdLc) installedByPid.set(m.about.packageIdLc, m);
  }
  const closure = new Set<string>();
  const missingDeps = new Set<string>();
  const queue: string[] = [targetPid];
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

  const before = snapshot.activeOrder.slice();
  const beforeSet = new Set(before);
  const desired = before.slice();
  const added: string[] = [];
  if (!alreadyEnabled) {
    desired.push(targetPid);
    added.push(targetPid);
  }
  for (const dep of closure) {
    if (!beforeSet.has(dep)) {
      desired.push(dep);
      added.push(dep);
    }
  }

  const sorted = autosort({
    activeOrder: desired,
    snapshot,
    rules,
  });

  const reordered =
    sorted.order.length !== before.length ||
    sorted.order.some((p, i) => p !== before[i]);
  if (reordered) {
    await registry.setActiveMods(sorted.order);
  }

  const launch = await launchRimWorld({
    args: quicktest ? ['-quicktest'] : [],
  });

  const lines: string[] = [];
  lines.push(`Synced ${opts.folder} into RimWorld's Mods/.`);
  if (added.length === 0) {
    lines.push(`${targetPid} and its deps were already in <activeMods>.`);
  } else {
    lines.push(`Added to <activeMods>: ${added.join(', ')}.`);
  }
  if (missingDeps.size > 0) {
    lines.push(
      `Declared deps NOT installed (mod will fail to load until installed): ${[...missingDeps].join(', ')}.`,
    );
  }
  if (reordered && added.length === 0) {
    lines.push('Reordered active mods via autosort.');
  }
  if (sorted.conflicts.length > 0) {
    lines.push(
      `${sorted.conflicts.length} ordering constraint(s) skipped (would have introduced a cycle).`,
    );
  }
  lines.push(
    launch.alreadyRunning
      ? 'RimWorld was running again by launch time; the spawn was a no-op. Tell the user to quit and retry.'
      : `Launched RimWorld${quicktest ? ' with -quicktest (skipping menus into a generated map)' : ''}.`,
  );

  return {
    text: lines.join(' '),
    details: {
      folder: opts.folder,
      packageId: targetPid,
      alreadyEnabled,
      added,
      missingDeps: [...missingDeps],
      reordered,
      conflicts: sorted.conflicts.length,
      alreadyRunning: launch.alreadyRunning,
      quicktest,
      isolated: false,
    },
  };
}
