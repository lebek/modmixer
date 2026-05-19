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
import {
  BRIDGE_PACKAGE_ID,
  ensureBridgeInstalled,
  type BridgeInstallResult,
} from './bridge-install.js';

/**
 * Append the bridge packageId to an active-mod list when the bridge is
 * loadable. Idempotent — a no-op if the list already contains it (the user
 * may have explicitly added it themselves, in which case we keep their
 * position rather than moving it to the end).
 */
function appendBridgeIfAvailable(
  activeMods: string[],
  bridge: BridgeInstallResult,
): string[] {
  if (!bridge.available) return activeMods;
  if (activeMods.includes(BRIDGE_PACKAGE_ID)) return activeMods;
  return [...activeMods, BRIDGE_PACKAGE_ID];
}

export interface ShipAndLaunchOptions {
  folder: string;
  /** Default true. Pass `-quicktest`. */
  quicktest?: boolean;
  /** Default true. Launch with `-savedatafolder=<modmixer-test-dir>`. */
  isolated?: boolean;
  /**
   * PackageIds of already-installed mods to co-load with the target for
   * compat testing. Isolated mode only — ignored when isolated is false
   * (the user's real list already loads everything).
   */
  companionMods?: string[];
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
  /** Requested companion mods that aren't installed; empty in non-isolated mode. */
  missingCompanions: string[];
  reordered: boolean;
  conflicts: number;
  alreadyRunning: boolean;
  quicktest: boolean;
  isolated: boolean;
  savedataDir?: string;
  /**
   * Workspace folder ids whose RimWorld symlinks we pruned during sync
   * because they shared the target's packageId. Surfaced so the agent (and
   * the user reading the tool result) knows duplicate-id warnings should
   * have stopped after this run.
   */
  removedStaleSiblings: string[];
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

  const { removedStaleSiblings } = await syncModToGame(opts.folder);

  const registry = getRegistry();
  await registry.start();
  await registry.refresh();
  let snapshot = registry.getSnapshot();

  // Install the in-game bridge mod (in addition to the workspace mod being
  // tested) so error/warning/perf/patch diagnostics stream over the
  // localhost TCP socket. Skipped when the user already has the bridge
  // installed via Workshop or as a real folder under Mods/. After the
  // junction lands we refresh the registry so computeTestSet's dep walk and
  // autosort see the bridge alongside everything else, and so the
  // <activeMods> entry we append below isn't reported as missing.
  const bridge = await ensureBridgeInstalled(snapshot);
  if (bridge.installed) {
    await registry.refresh();
    snapshot = registry.getSnapshot();
  }

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
      companionPackageIds: opts.companionMods,
      rules,
    });
    const companionCount =
      (opts.companionMods ?? []).length - testSet.missingCompanions.length;
    // Append the bridge packageId after autosort so it loads last — the
    // bridge's Harmony patches register on ModContentPack ctor, and we want
    // them to see every other mod's patches already in place when it
    // initializes the patch graph snapshot.
    const activeMods = appendBridgeIfAvailable(testSet.reducedActive, bridge);
    // Carry over <version> and <knownExpansions> from the user's real
    // ModsConfig so DLCs the user owns stay declared in the isolated copy
    // (knownExpansions gates DLC content even though the active list also
    // lists DLC packageIds).
    const real = await readModsConfig();
    const sd = await buildTestSavedata({
      activeMods,
      knownExpansions: real.knownExpansions,
      version: real.version,
    });
    const launch = await launchRimWorld({
      args: quicktest ? ['-quicktest'] : [],
      savedataFolder: sd.savedataDir,
    });

    const lines: string[] = [];
    lines.push(`Synced ${opts.folder} into RimWorld's Mods/.`);
    if (removedStaleSiblings.length > 0) {
      lines.push(
        `Pruned ${removedStaleSiblings.length} stale sibling sync(s) sharing packageId ${targetPid} (workspace folders: ${removedStaleSiblings.join(', ')}) — RimWorld will stop warning about duplicates.`,
      );
    }
    lines.push(
      `Isolated test session: wrote ${activeMods.length} active mods (Core+DLCs+target+deps${companionCount > 0 ? '+companions' : ''}${bridge.available ? '+bridge' : ''}) to ${sd.configPath}. Real ModsConfig.xml is untouched.`,
    );
    if (testSet.missing.length > 0) {
      lines.push(
        `Declared deps NOT installed (mod will fail to load until installed): ${testSet.missing.join(', ')}.`,
      );
    }
    if (testSet.missingCompanions.length > 0) {
      lines.push(
        `Companion mods NOT installed (can't be co-loaded): ${testSet.missingCompanions.join(', ')}.`,
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
        added: activeMods,
        missingDeps: testSet.missing,
        missingCompanions: testSet.missingCompanions,
        reordered: false,
        conflicts: 0,
        alreadyRunning: launch.alreadyRunning,
        quicktest,
        isolated: true,
        savedataDir: sd.savedataDir,
        removedStaleSiblings,
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

  // Same bridge-at-the-end story as the isolated path. We don't add the
  // bridge to `added` though — the bridge is infrastructure, not part of
  // the mod-test diff we report back to the agent.
  const finalActiveOrder = appendBridgeIfAvailable(sorted.order, bridge);

  const reordered =
    finalActiveOrder.length !== before.length ||
    finalActiveOrder.some((p, i) => p !== before[i]);
  if (reordered) {
    await registry.setActiveMods(finalActiveOrder);
  }

  const launch = await launchRimWorld({
    args: quicktest ? ['-quicktest'] : [],
  });

  const lines: string[] = [];
  lines.push(`Synced ${opts.folder} into RimWorld's Mods/.`);
  if (removedStaleSiblings.length > 0) {
    lines.push(
      `Pruned ${removedStaleSiblings.length} stale sibling sync(s) sharing packageId ${targetPid} (workspace folders: ${removedStaleSiblings.join(', ')}) — RimWorld will stop warning about duplicates.`,
    );
  }
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
      missingCompanions: [],
      reordered,
      conflicts: sorted.conflicts.length,
      alreadyRunning: launch.alreadyRunning,
      quicktest,
      isolated: false,
      removedStaleSiblings,
    },
  };
}
