// Compute the minimal active mod list for a "test this mod" session:
//   Core + currently-active official DLCs + target mod + transitive deps.
//
// We resolve transitive deps recursively so a mod that depends on
// "VanillaExpanded.Core" still gets that pulled in even though the target's
// About.xml only mentions one level. Cycles are tolerated.

import type { RegistryMod, RegistrySnapshot } from './types.js';
import { autosort } from './autosort.js';
import type { CommunityRule } from './community-rules.js';

const OFFICIAL_PIDS = [
  'ludeon.rimworld',
  'ludeon.rimworld.royalty',
  'ludeon.rimworld.ideology',
  'ludeon.rimworld.biotech',
  'ludeon.rimworld.anomaly',
];

export interface TestSetResult {
  /** Lowercased packageIds of the reduced set. */
  reducedActive: string[];
  /** Lowercased packageIds of deps that aren't installed on disk. */
  missing: string[];
  /** Lowercased packageIds of requested companion mods not installed on disk. */
  missingCompanions: string[];
}

export function computeTestSet(args: {
  snapshot: RegistrySnapshot;
  /** Lowercased packageId of the target mod. */
  targetPackageId: string;
  /**
   * PackageIds of already-installed mods to load alongside the target (for
   * compat testing). Their transitive deps are resolved like the target's.
   */
  companionPackageIds?: string[];
  /** Soft-rule community DB (used for autosort of the reduced set). */
  rules?: Map<string, CommunityRule>;
}): TestSetResult {
  const { snapshot, targetPackageId, companionPackageIds, rules } = args;
  const target = targetPackageId.toLowerCase();
  const byPid = new Map<string, RegistryMod>();
  for (const m of snapshot.mods) {
    if (m.about.packageIdLc) byPid.set(m.about.packageIdLc, m);
  }

  const required = new Set<string>();
  // Always include Core. DLCs only if the user already had them active —
  // forcing all DLCs on would mass-enable content the user doesn't own.
  if (byPid.has('ludeon.rimworld')) required.add('ludeon.rimworld');
  for (const pid of OFFICIAL_PIDS) {
    if (pid === 'ludeon.rimworld') continue;
    if (snapshot.activeOrder.includes(pid)) required.add(pid);
  }

  const missing: string[] = [];
  const missingCompanions: string[] = [];
  // Seed the dep walk with the target plus any companion mods. Companions
  // that aren't installed are reported separately — they're a deliberate
  // co-load request, not a broken dependency of the target.
  const stack: string[] = [target];
  for (const raw of companionPackageIds ?? []) {
    const pid = raw.toLowerCase();
    if (pid === target) continue;
    if (byPid.has(pid)) stack.push(pid);
    else if (!missingCompanions.includes(pid)) missingCompanions.push(pid);
  }
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (required.has(pid)) continue;
    required.add(pid);
    const mod = byPid.get(pid);
    if (!mod) {
      // Don't list the target itself as missing — the caller will surface that
      // separately if it's not installed.
      if (pid !== target) missing.push(pid);
      continue;
    }
    for (const dep of mod.about.modDependencies) {
      if (!required.has(dep.packageIdLc)) stack.push(dep.packageIdLc);
    }
  }

  // Autosort the reduced set so test launches start in a sensible order.
  const sorted = autosort({
    activeOrder: Array.from(required),
    snapshot,
    rules: rules ?? new Map(),
  });
  return { reducedActive: sorted.order, missing, missingCompanions };
}

export interface ActiveDiff {
  added: string[];
  removed: string[];
  /** True when the order of the intersection differs (mods reordered). */
  reordered: boolean;
}

/**
 * Diff two active-mod lists. Used by the fix-session "apply or revert?" UI
 * to show the user what the agent changed.
 */
export function diffActiveLists(initial: string[], current: string[]): ActiveDiff {
  const init = initial.map((s) => s.toLowerCase());
  const cur = current.map((s) => s.toLowerCase());
  const initSet = new Set(init);
  const curSet = new Set(cur);
  const added = cur.filter((p) => !initSet.has(p));
  const removed = init.filter((p) => !curSet.has(p));
  // Check whether the intersection preserved its relative order.
  const intersection = init.filter((p) => curSet.has(p));
  const intersectionInCur = cur.filter((p) => initSet.has(p));
  let reordered = false;
  for (let i = 0; i < intersection.length; i++) {
    if (intersection[i] !== intersectionInCur[i]) {
      reordered = true;
      break;
    }
  }
  return { added, removed, reordered };
}
