// Autosort — produce a load order that respects:
//   1. Hard deps from About.xml (modDependencies + loadAfter + loadBefore)
//   2. Soft preferences from the community rules DB (loadAfter / loadBefore /
//      loadBottom)
//   3. Reasonable defaults: Core first, official DLCs second in canonical
//      order, "loadBottom"-tagged mods last.
//
// Algorithm: stable topological sort. We build a directed graph where an
// edge from A → B means "A must load before B". Hard constraints add edges;
// soft constraints add edges only if they don't introduce a cycle. Ties
// break on the original input order (stable) so the user's manual ordering
// is preserved when no rule applies.

import type { RegistryMod, RegistrySnapshot } from './types.js';
import type { CommunityRule } from './community-rules.js';

export interface AutosortOptions {
  /** Active mods (lowercased packageIds) in current order. */
  activeOrder: string[];
  /** Full registry snapshot for dep lookup. */
  snapshot: RegistrySnapshot;
  /** Community rules keyed by lowercased packageId. */
  rules: Map<string, CommunityRule>;
}

export interface AutosortResult {
  /** New ordered list of lowercased packageIds. */
  order: string[];
  /** Constraints we couldn't satisfy (would have introduced a cycle). */
  conflicts: AutosortConflict[];
}

export interface AutosortConflict {
  source: 'about-xml' | 'community-rule';
  kind: 'load-after' | 'load-before';
  /** Lowercased packageId of the mod declaring the constraint. */
  declaredBy: string;
  /** Lowercased packageId on the other side of the constraint. */
  other: string;
}

// Fixed-priority head of the load order. Harmony (when active) comes before
// Core because Harmony patches need to attach to Core's static initializers
// before they run — Brrainz's recommended ordering. Then Core, then DLCs in
// canonical Ludeon order. Mods not in this list follow.
const LOAD_PRIORITY = [
  'brrainz.harmony',
  'ludeon.rimworld',
  'ludeon.rimworld.royalty',
  'ludeon.rimworld.ideology',
  'ludeon.rimworld.biotech',
  'ludeon.rimworld.anomaly',
];

export function autosort(opts: AutosortOptions): AutosortResult {
  const { activeOrder, snapshot, rules } = opts;
  const conflicts: AutosortConflict[] = [];

  // Deduplicate, lowercase, preserve order.
  const ids = dedupe(activeOrder.map((s) => s.toLowerCase()));
  const idSet = new Set(ids);

  const modByPid = new Map<string, RegistryMod>();
  for (const m of snapshot.mods) {
    if (m.about.packageIdLc) modByPid.set(m.about.packageIdLc, m);
  }

  // Build adjacency: edges[a] = set of nodes that must come AFTER a.
  const after = new Map<string, Set<string>>();
  for (const id of ids) after.set(id, new Set());

  function addEdge(
    fromPid: string,
    toPid: string,
    source: AutosortConflict['source'],
    declaredBy: string,
    kind: AutosortConflict['kind'],
  ): void {
    if (!idSet.has(fromPid) || !idSet.has(toPid)) return;
    if (fromPid === toPid) return;
    if (after.get(fromPid)!.has(toPid)) return;
    // Tentatively add and check for cycle by attempting a topological pass.
    after.get(fromPid)!.add(toPid);
    if (hasCycle(after, ids)) {
      after.get(fromPid)!.delete(toPid);
      conflicts.push({ source, kind, declaredBy, other: toPid === declaredBy ? fromPid : toPid });
    }
  }

  // 1. Hard constraints from About.xml.
  for (const id of ids) {
    const mod = modByPid.get(id);
    if (!mod) continue;
    for (const dep of mod.about.modDependencies) {
      // dep must come before us
      addEdge(dep.packageIdLc, id, 'about-xml', id, 'load-after');
    }
    for (const a of mod.about.loadAfter) {
      addEdge(a, id, 'about-xml', id, 'load-after');
    }
    for (const b of mod.about.loadBefore) {
      addEdge(id, b, 'about-xml', id, 'load-before');
    }
  }

  // 2. Soft constraints from community rules.
  for (const id of ids) {
    const rule = rules.get(id);
    if (!rule) continue;
    for (const a of rule.loadAfter) {
      addEdge(a, id, 'community-rule', id, 'load-after');
    }
    for (const b of rule.loadBefore) {
      addEdge(id, b, 'community-rule', id, 'load-before');
    }
  }

  // 3. Fixed load priority — Harmony, then Core, then DLCs go first when
  // active, in that canonical order. Everything else follows.
  for (let i = 0; i < LOAD_PRIORITY.length; i++) {
    const before = LOAD_PRIORITY[i];
    if (!idSet.has(before)) continue;
    for (let j = i + 1; j < LOAD_PRIORITY.length; j++) {
      const next = LOAD_PRIORITY[j];
      if (!idSet.has(next)) continue;
      addEdge(before, next, 'about-xml', before, 'load-before');
    }
    // Priority entries should come before everything else.
    for (const id of ids) {
      if (LOAD_PRIORITY.includes(id)) continue;
      addEdge(before, id, 'about-xml', before, 'load-before');
    }
  }

  // 4. Stable topological sort using Kahn's algorithm with priority by the
  // input order: when multiple nodes are eligible, pick the one with the
  // smallest input index. loadBottom-tagged mods are biased to be picked last.
  const inDegree = new Map<string, number>();
  for (const id of ids) inDegree.set(id, 0);
  for (const [from, tos] of after) {
    for (const to of tos) {
      inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
    }
  }

  const inputOrder = new Map<string, number>();
  ids.forEach((id, i) => inputOrder.set(id, i));

  function bias(id: string): number {
    const rule = rules.get(id);
    if (rule?.loadBottom) return 1_000_000;
    return inputOrder.get(id) ?? 0;
  }

  const result: string[] = [];
  const ready = ids.filter((id) => inDegree.get(id) === 0);
  while (ready.length > 0) {
    ready.sort((a, b) => bias(a) - bias(b));
    const next = ready.shift()!;
    result.push(next);
    for (const to of after.get(next) ?? []) {
      const d = (inDegree.get(to) ?? 1) - 1;
      inDegree.set(to, d);
      if (d === 0) ready.push(to);
    }
  }

  // If we somehow have a cycle remaining (shouldn't because we rejected
  // cycle-creating edges above), append the rest in input order.
  if (result.length < ids.length) {
    const placed = new Set(result);
    for (const id of ids) {
      if (!placed.has(id)) result.push(id);
    }
  }

  return { order: result, conflicts };
}

function hasCycle(edges: Map<string, Set<string>>, ids: string[]): boolean {
  const inDeg = new Map<string, number>();
  for (const id of ids) inDeg.set(id, 0);
  for (const [, tos] of edges) {
    for (const to of tos) inDeg.set(to, (inDeg.get(to) ?? 0) + 1);
  }
  const queue = ids.filter((id) => inDeg.get(id) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const n = queue.shift()!;
    visited++;
    for (const to of edges.get(n) ?? []) {
      const d = (inDeg.get(to) ?? 1) - 1;
      inDeg.set(to, d);
      if (d === 0) queue.push(to);
    }
  }
  return visited !== ids.length;
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}
