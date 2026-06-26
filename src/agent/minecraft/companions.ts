/**
 * Resolving "load this mod alongside the one under test" requests for the
 * Minecraft test loop — the NeoForge analog of RimWorld's companionMods. The
 * agent names installed mods (e.g. "make this work with Create"); we resolve
 * each to its jar on disk via the installed-mods registry and hand the paths to
 * `runClient`, which adds them to the dev client's runtime classpath so FML
 * discovers and loads them next to the user's mod.
 *
 * Two honesty guards, neither of which RimWorld needs:
 *  - We add ONLY the named jars, not their transitive dependencies. NeoForge has
 *    no installed load-order to walk the way RimWorld's ModsConfig does, so a
 *    companion with required deps needs those named too; we surface that.
 *  - The dev client is pinned to one Minecraft / NeoForge version. A companion
 *    built for another version (or a Fabric-only jar) can't load, so we flag the
 *    mismatch up front instead of letting it surface as a cryptic load error.
 */
import {
  findInstalledMinecraftMod,
  type InstalledMinecraftMod,
} from './mods-registry.js';
import { MINECRAFT_VERSION, NEOFORGE_VERSION } from './versions.js';

export interface ResolvedCompanion {
  /** The query the agent passed (modId or name). */
  query: string;
  mod: InstalledMinecraftMod;
  jarPath: string;
  /** Non-null when the jar likely can't load against the pinned target. */
  versionWarning: string | null;
}

export interface CompanionResolution {
  resolved: ResolvedCompanion[];
  /** Queries that matched no installed mod. */
  notFound: string[];
  /** De-duplicated jar paths to add to the runClient classpath. */
  jarPaths: string[];
}

/**
 * Resolve companion-mod queries to installed jars. Best-effort: an unmatched
 * query goes to `notFound` rather than throwing, and a jar already pulled in by
 * an earlier query (or a multi-mod jar matched twice) is added once.
 */
export async function resolveCompanions(
  queries: string[],
): Promise<CompanionResolution> {
  const resolved: ResolvedCompanion[] = [];
  const notFound: string[] = [];
  const seenJars = new Set<string>();
  for (const raw of queries) {
    const query = raw.trim();
    if (!query) continue;
    const mod = await findInstalledMinecraftMod(query);
    if (!mod) {
      notFound.push(query);
      continue;
    }
    if (seenJars.has(mod.jarPath)) continue;
    seenJars.add(mod.jarPath);
    resolved.push({
      query,
      mod,
      jarPath: mod.jarPath,
      versionWarning: companionVersionWarning(mod),
    });
  }
  return { resolved, notFound, jarPaths: [...seenJars] };
}

/**
 * Why a companion likely won't load against the pinned dev client: a declared
 * minecraft/neoforge dependency range that excludes our target, or a Fabric-only
 * jar. Returns null when the jar looks compatible or we can't tell.
 */
function companionVersionWarning(mod: InstalledMinecraftMod): string | null {
  if (mod.loader === 'fabric') {
    return `is a Fabric mod and cannot load under NeoForge ${NEOFORGE_VERSION}`;
  }
  const notes: string[] = [];
  const mc = mod.dependencies.find((d) => d.modId === 'minecraft');
  if (mc?.versionRange && versionInRange(MINECRAFT_VERSION, mc.versionRange) === false) {
    notes.push(`targets Minecraft ${mc.versionRange}, not ${MINECRAFT_VERSION}`);
  }
  const neo = mod.dependencies.find((d) => d.modId === 'neoforge');
  if (neo?.versionRange && versionInRange(NEOFORGE_VERSION, neo.versionRange) === false) {
    notes.push(`targets NeoForge ${neo.versionRange}, not ${NEOFORGE_VERSION}`);
  }
  return notes.length ? notes.join('; ') : null;
}

/** Compare dotted versions segment-wise (numeric where possible). -1 | 0 | 1. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const sa = pa[i] ?? '0';
    const sb = pb[i] ?? '0';
    const na = Number(sa);
    const nb = Number(sb);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Best-effort Maven version-range check — the syntax NeoForge mods.toml uses for
 * dependency ranges: `[a,b]` inclusive, `(a,b)` exclusive, `[a,)` open-ended,
 * `[a]` exact; a comma-separated list of intervals admits if ANY admits. Returns
 * true (admits), false (excludes), or null when undecidable (e.g. a bare version,
 * which Maven treats as a soft recommendation, not a hard bound — never warn on
 * those). Deliberately only used to *flag* a likely-bad companion, never to block.
 */
export function versionInRange(version: string, range: string): boolean | null {
  const r = range.trim();
  if (!r) return null;
  const intervals = r.match(/[[(][^\])]*[\])]/g);
  if (!intervals || intervals.length === 0) return null; // bare/soft version
  for (const itv of intervals) {
    const lowerInc = itv.startsWith('[');
    const upperInc = itv.endsWith(']');
    const inner = itv.slice(1, -1);
    const commaIdx = inner.indexOf(',');
    if (commaIdx === -1) {
      if (compareVersions(version, inner.trim()) === 0) return true; // [x] exact
      continue;
    }
    const lo = inner.slice(0, commaIdx).trim();
    const hi = inner.slice(commaIdx + 1).trim();
    let ok = true;
    if (lo) {
      const c = compareVersions(version, lo);
      ok = ok && (lowerInc ? c >= 0 : c > 0);
    }
    if (hi) {
      const c = compareVersions(version, hi);
      ok = ok && (upperInc ? c <= 0 : c < 0);
    }
    if (ok) return true;
  }
  return false;
}
