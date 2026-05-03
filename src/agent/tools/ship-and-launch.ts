import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { isRimWorldRunning, launchRimWorld } from '../game.js';
import { syncModToGame } from '../workspace.js';
import {
  autosort,
  getCommunityRules,
  getRegistry,
  type RegistryMod,
} from '../registry/index.js';

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
});

export interface ShipAndLaunchDetails {
  folder: string;
  /** packageId discovered in About.xml. */
  packageId: string;
  /** True if the target mod was already in <activeMods>. */
  alreadyEnabled: boolean;
  /** Lowercased packageIds we just added to <activeMods> (target + transitive deps). */
  added: string[];
  /**
   * Declared-but-not-installed deps. Populated from <modDependencies> walks
   * of the target and any transitively-reached mods. The mod will fail to
   * load until the user installs/subscribes these.
   */
  missingDeps: string[];
  /** True if autosort reordered the active list (added or moved entries). */
  reordered: boolean;
  /** Number of cycle-creating ordering constraints autosort had to drop. */
  conflicts: number;
  /** True if RimWorld was already running when we tried to launch. */
  alreadyRunning: boolean;
  /** True when we passed `-quicktest` to the game. */
  quicktest: boolean;
}

/**
 * Single-call replacement for `sync_to_game` → `enable_mod_in_game` →
 * `launch_rimworld`, which the agent always runs in that order in the
 * test-in-game flow. Bundling them removes 2 round-trips per cycle and
 * makes intent explicit.
 *
 * Walks `<modDependencies>` transitively: any installed dep that isn't yet
 * in <activeMods> gets added so the game doesn't TypeLoadException at boot
 * (the classic case is `brrainz.harmony` — the workspace mod compiles
 * against Harmony but the runtime DLL is provided by that other mod, which
 * has to be loaded too). After adding, runs `autosort` so Core/DLCs/deps
 * end up in a valid order.
 *
 * RimWorld must be CLOSED — same precondition as `enable_mod_in_game`,
 * since this edits ModsConfig.xml. We check up front and refuse with a
 * clear message instead of letting the inner call raise. The agent should
 * pair this with `quit_rimworld` (which blocks until exit) when RimWorld
 * was already running.
 */
export const shipAndLaunchTool: AgentTool<typeof Params, ShipAndLaunchDetails> = {
  name: 'ship_and_launch',
  label: 'Ship mod & launch RimWorld',
  description:
    "Symlink the mod into RimWorld's Mods/, walk <modDependencies> and add the target plus any installed transitive deps to <activeMods>, autosort the result, and cold-start the game by spawning RimWorldWin64.exe directly (Steam still has to be running for Steamworks; the launcher is not). Defaults to passing `-quicktest` so the user lands straight in a generated map — disable with quicktest=false only when the test needs the menus. RimWorld must be CLOSED when this runs (the game rewrites ModsConfig.xml on quit). Pair with quit_rimworld first if it's running. Surfaces declared deps that aren't installed (mod will fail to load until the user subscribes/installs them). After this returns, call watch_player_log to begin background error monitoring; do NOT block the user's turn waiting for them to test.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<ShipAndLaunchDetails>> {
    if (await isRimWorldRunning()) {
      throw new Error(
        'RimWorld is currently running. ship_and_launch needs the game closed so it can edit ModsConfig.xml. Confirm with the user, then call quit_rimworld first (it now blocks until the process exits), then retry ship_and_launch.',
      );
    }

    // 1. Sync the workspace mod into RimWorld's Mods/ so its packageId
    // resolves on disk.
    await syncModToGame(params.folder);

    // 2. Refresh the registry — the sync may have just created the symlink
    // and we need its post-sync view (workspaceSynced flags etc.).
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

    // 3. Walk <modDependencies> transitively, restricted to mods that are
    // actually installed on this machine. Anything declared-but-missing is
    // surfaced to the user — adding it to <activeMods> wouldn't help (the
    // game would just warn and skip), and skipping silently is what caused
    // the `TypeLoadException: HarmonyLib.HarmonyPatch` bug in the first
    // place.
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

    // 4. Build the desired active list: existing + target + dep closure.
    // Then autosort to honor dep edges and Core/DLC priority.
    const before = snapshot.activeOrder.slice();
    const beforeSet = new Set(before);
    const desired = before.slice();
    const added: string[] = [];
    const alreadyEnabled = beforeSet.has(targetPid);
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

    const rules = await getCommunityRules();
    const sorted = autosort({
      activeOrder: desired,
      snapshot,
      rules: rules.byPackageId,
    });

    const reordered =
      sorted.order.length !== before.length ||
      sorted.order.some((p, i) => p !== before[i]);
    if (reordered) {
      await registry.setActiveMods(sorted.order);
    }

    // 5. Launch. Default to -quicktest so the user lands in-game without
    // grinding through menus; agent can opt out for menu-driven tests.
    const quicktest = params.quicktest !== false;
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
        ? // Should be unreachable given the precheck, but keep the message
          // in case a stray instance appears between the check and the spawn.
          'RimWorld was running again by launch time; the spawn was a no-op. Tell the user to quit and retry.'
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
      },
    };
  },
};
