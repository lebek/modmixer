// Derived analysis on top of a RegistrySnapshot. Produces the flags shown as
// badges in the Library UI and consumed by the diagnostic agent flow:
//   - missing dependency (active mod requires X, X not active)
//   - incompatible mods both active
//   - load-order violation (loadAfter / loadBefore declarations not respected)
//   - version mismatch (mod's supportedVersions does not include the running
//     game's major.minor)

import type { RegistryMod, RegistrySnapshot } from './types.js';

export type IssueKind =
  | 'missing-dependency'
  | 'incompatible-mod-active'
  | 'load-order-violation'
  | 'version-incompat';

export interface ModIssue {
  kind: IssueKind;
  /** Lowercased packageId of the mod the issue is reported against. */
  packageId: string;
  /** Lowercased packageId of the related mod (the missing dep, the
   * incompatible peer, the mod whose order is violated). May be empty for
   * version-incompat. */
  otherPackageId: string;
  /** One-sentence human-readable description used in tooltips and the agent
   * diagnostic context. */
  message: string;
}

export interface AnalysisResult {
  /** All issues across the active list, in the order they were detected. */
  issues: ModIssue[];
  /** Issues bucketed by packageId (lowercased) for fast UI lookup. */
  byPackageId: Map<string, ModIssue[]>;
}

export function analyzeSnapshot(snapshot: RegistrySnapshot): AnalysisResult {
  const issues: ModIssue[] = [];
  const activeIndex = new Map<string, number>();
  for (let i = 0; i < snapshot.activeOrder.length; i++) {
    activeIndex.set(snapshot.activeOrder[i], i);
  }
  const activeIds = new Set(snapshot.activeOrder);
  const byPackageId = new Map<string, RegistryMod>();
  for (const mod of snapshot.mods) {
    if (mod.about.packageIdLc) byPackageId.set(mod.about.packageIdLc, mod);
  }

  for (const activePackageId of snapshot.activeOrder) {
    const mod = byPackageId.get(activePackageId);
    if (!mod) continue;
    const idx = activeIndex.get(activePackageId)!;

    // Missing dependencies.
    for (const dep of mod.about.modDependencies) {
      if (!activeIds.has(dep.packageIdLc)) {
        issues.push({
          kind: 'missing-dependency',
          packageId: activePackageId,
          otherPackageId: dep.packageIdLc,
          message: `Missing dependency: ${dep.displayName || dep.packageId}`,
        });
      }
    }

    // Incompatibilities.
    for (const incompat of mod.about.incompatibleWith) {
      if (activeIds.has(incompat)) {
        issues.push({
          kind: 'incompatible-mod-active',
          packageId: activePackageId,
          otherPackageId: incompat,
          message: `Conflicts with active mod: ${incompat}`,
        });
      }
    }

    // Load-after: mod declares it must load after X. X must come before us
    // (smaller index) when both are active.
    for (const after of mod.about.loadAfter) {
      const otherIdx = activeIndex.get(after);
      if (otherIdx === undefined) continue;
      if (otherIdx >= idx) {
        issues.push({
          kind: 'load-order-violation',
          packageId: activePackageId,
          otherPackageId: after,
          message: `Should load after ${after} but currently loads before it`,
        });
      }
    }
    // Load-before: X must come after us. Other index must be greater.
    for (const before of mod.about.loadBefore) {
      const otherIdx = activeIndex.get(before);
      if (otherIdx === undefined) continue;
      if (otherIdx <= idx) {
        issues.push({
          kind: 'load-order-violation',
          packageId: activePackageId,
          otherPackageId: before,
          message: `Should load before ${before} but currently loads after it`,
        });
      }
    }

    // Version-incompat (display flag only — does not block loading).
    if (
      snapshot.gameVersionMajorMinor &&
      mod.about.supportedVersions.length > 0 &&
      !mod.about.supportedVersions.includes(snapshot.gameVersionMajorMinor)
    ) {
      issues.push({
        kind: 'version-incompat',
        packageId: activePackageId,
        otherPackageId: '',
        message: `Mod supports ${mod.about.supportedVersions.join(', ')}; game is ${snapshot.gameVersionMajorMinor}`,
      });
    }
  }

  // Inactive mods can still be flagged as version-incompat for the UI badge.
  for (const mod of snapshot.mods) {
    if (!mod.about.packageIdLc) continue;
    if (activeIds.has(mod.about.packageIdLc)) continue;
    if (
      snapshot.gameVersionMajorMinor &&
      mod.about.supportedVersions.length > 0 &&
      !mod.about.supportedVersions.includes(snapshot.gameVersionMajorMinor)
    ) {
      issues.push({
        kind: 'version-incompat',
        packageId: mod.about.packageIdLc,
        otherPackageId: '',
        message: `Mod supports ${mod.about.supportedVersions.join(', ')}; game is ${snapshot.gameVersionMajorMinor}`,
      });
    }
  }

  const byPid = new Map<string, ModIssue[]>();
  for (const issue of issues) {
    let bucket = byPid.get(issue.packageId);
    if (!bucket) {
      bucket = [];
      byPid.set(issue.packageId, bucket);
    }
    bucket.push(issue);
  }
  return { issues, byPackageId: byPid };
}
