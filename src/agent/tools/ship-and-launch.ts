import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { isRimWorldRunning, launchRimWorld } from '../game.js';
import { syncModToGame } from '../workspace.js';
import {
  autosort,
  computeTestSet,
  getCommunityRules,
  getRegistry,
  readModsConfig,
  type RegistryMod,
} from '../registry/index.js';
import { buildTestSavedata } from '../test-savedata.js';

const Params = Type.Object({
  folder: Type.String({
    description: 'Workspace mod folder name to ship to RimWorld and launch.',
  }),
  quicktest: Type.Optional(
    Type.Boolean({
      description:
        "Default true. Pass `-quicktest` so RimWorld bypasses the main menu and drops the user straight into a generated map — combined with prepare_debug_session this gives a one-keypress test loop. Set false ONLY when the test genuinely needs the menus (ScenarioDef in the scenario picker, custom main-menu UI, mod options, save-load flows).",
    }),
  ),
  isolated: Type.Optional(
    Type.Boolean({
      description:
        "Default true. Launch with `-savedatafolder=<modmixer-test-dir>` so the test session reads/writes a separate ModsConfig.xml, Prefs.xml, and saves — the user's real mod list is untouched even if RimWorld crashes. Active list is reduced to Core + the user's currently-active DLCs + target mod + transitive deps. Set false to mutate the user's real ModsConfig.xml and launch with their full list (use only when the test genuinely needs the user's other mods loaded).",
    }),
  ),
});

export interface ShipAndLaunchDetails {
  folder: string;
  /** packageId discovered in About.xml. */
  packageId: string;
  /** True if the target mod was already in the real <activeMods>. */
  alreadyEnabled: boolean;
  /**
   * In isolated mode: the reduced active list written to the test ModsConfig.
   * In non-isolated mode: lowercased packageIds we just added to the real
   * <activeMods> (target + transitive deps).
   */
  added: string[];
  /**
   * Declared-but-not-installed deps. Populated from <modDependencies> walks
   * of the target and any transitively-reached mods. The mod will fail to
   * load until the user installs/subscribes these.
   */
  missingDeps: string[];
  /** True if autosort reordered the active list (non-isolated mode only). */
  reordered: boolean;
  /** Number of cycle-creating ordering constraints autosort had to drop. */
  conflicts: number;
  /** True if RimWorld was already running when we tried to launch. */
  alreadyRunning: boolean;
  /** True when we passed `-quicktest` to the game. */
  quicktest: boolean;
  /** True when we launched into the isolated test savedata. */
  isolated: boolean;
  /** Absolute path of the test savedata dir (isolated mode only). */
  savedataDir?: string;
}

/**
 * Single-call replacement for `sync_to_game` → `enable_mod_in_game` →
 * `launch_rimworld`, which the agent always runs in that order in the
 * test-in-game flow. Bundling them removes 2 round-trips per cycle and
 * makes intent explicit.
 *
 * Default mode is **isolated**: writes a reduced active list (Core +
 * currently-active DLCs + target + transitive deps) to a separate savedata
 * folder via `-savedatafolder`, leaving the user's real ModsConfig.xml
 * untouched. The reduced set is built by `computeTestSet`, which BFS-walks
 * <modDependencies> over installed mods and runs autosort on the result.
 *
 * Non-isolated mode mutates the user's real <activeMods> (legacy behavior):
 * walks <modDependencies> transitively, adds installed deps to the live
 * list, autosorts, and refuses to run while RimWorld is open (since the
 * game rewrites ModsConfig.xml on quit).
 */
export const shipAndLaunchTool: AgentTool<typeof Params, ShipAndLaunchDetails> = {
  name: 'ship_and_launch',
  label: 'Ship mod & launch RimWorld',
  description:
    "Symlink the mod into RimWorld's Mods/, then launch the game with that mod active. Default isolated=true: writes a reduced active list (Core + active DLCs + target + transitive deps) to a separate savedata folder via `-savedatafolder`, so the user's real ModsConfig.xml is never touched and a crash leaves their mod list intact. Set isolated=false to mutate the user's real <activeMods> and launch with their full list (legacy behavior; required only when the test needs the user's other mods loaded). Defaults to passing `-quicktest` so the user lands straight in a generated map. RimWorld must be CLOSED in either mode (game rewrites ModsConfig on quit and a running game is a no-op for re-launch). Pair with quit_rimworld first if it's running. Surfaces declared deps that aren't installed. After this returns, call watch_player_log to begin background error monitoring.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<ShipAndLaunchDetails>> {
    const isolated = params.isolated !== false;
    if (await isRimWorldRunning()) {
      throw new Error(
        'RimWorld is currently running. ship_and_launch needs the game closed (the game rewrites ModsConfig on quit, and a running instance turns a re-launch into a no-op). Confirm with the user, then call quit_rimworld first (it blocks until the process exits), then retry ship_and_launch.',
      );
    }

    // Sync the workspace mod into RimWorld's Mods/ so its packageId resolves
    // on disk. The install Mods/ dir is install-relative, NOT under the
    // savedata folder, so this is unchanged across both modes.
    await syncModToGame(params.folder);

    const registry = getRegistry();
    await registry.start();
    await registry.refresh();
    const snapshot = registry.getSnapshot();

    const targetMod = snapshot.mods.find(
      (m) => m.folder === params.folder && m.source === 'workspace',
    );
    if (!targetMod || !targetMod.about.packageIdLc) {
      throw new Error(
        `Could not resolve packageId for workspace mod "${params.folder}". Is About.xml present and well-formed?`,
      );
    }
    const targetPid = targetMod.about.packageIdLc;
    const alreadyEnabled = snapshot.activeOrder.includes(targetPid);
    const quicktest = params.quicktest !== false;
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
      lines.push(`Synced ${params.folder} into RimWorld's Mods/.`);
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
        content: [{ type: 'text', text: lines.join(' ') }],
        details: {
          folder: params.folder,
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

    // Non-isolated (legacy) path: mutate the user's real <activeMods>.
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
    lines.push(`Synced ${params.folder} into RimWorld's Mods/.`);
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
      content: [{ type: 'text', text: lines.join(' ') }],
      details: {
        folder: params.folder,
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
  },
};
