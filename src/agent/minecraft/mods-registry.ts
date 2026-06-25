import path from 'node:path';
import fsp from 'node:fs/promises';
import { detectMinecraftInstances, type Launcher } from './paths.js';
import { parseModManifest, type ParsedMod } from './mod-manifest.js';
import { readJarEntry } from '../index/minecraft-source.js';

export type { ModLoader, MinecraftModDependency } from './mod-manifest.js';

/**
 * Enumerating the third-party mods a user has *installed* in a launcher, so the
 * agent can survey them and pick one to inspect — the Minecraft analog of the
 * RimWorld mod registry. Unlike RimWorld (loose folders), NeoForge mods ship as
 * compiled `.jar`s, so the only metadata we can read cheaply is the manifest
 * embedded in each jar; we read just those entries via {@link readJarEntry}
 * rather than unpacking, and hand them to the pure {@link parseModManifest}.
 *
 * There is no runtime modlist/load-order to reconcile the way RimWorld's
 * ModsConfig.xml works — FML resolves load order from the declared dependency
 * graph at launch. "Enabled" is simply whether the file ends in `.jar` vs the
 * launcher-disabled `.jar.disabled`.
 */
export interface InstalledMinecraftMod extends ParsedMod {
  /** false when the file is `*.jar.disabled` (launcher-disabled). */
  enabled: boolean;
  jarPath: string;
  fileName: string;
  sizeBytes: number;
  instance: { launcher: Launcher; name: string };
}

interface JarContext {
  jarPath: string;
  fileName: string;
  fileNameStem: string;
  sizeBytes: number;
  enabled: boolean;
  instance: { launcher: Launcher; name: string };
}

async function readModsFromJar(ctx: JarContext): Promise<InstalledMinecraftMod[]> {
  const [neoforgeToml, modsToml, fabricJson] = await Promise.all([
    readJarEntry(ctx.jarPath, 'META-INF/neoforge.mods.toml'),
    readJarEntry(ctx.jarPath, 'META-INF/mods.toml'),
    readJarEntry(ctx.jarPath, 'fabric.mod.json'),
  ]);
  const parsed = parseModManifest({
    neoforgeToml,
    modsToml,
    fabricJson,
    fallbackId: ctx.fileNameStem,
  });
  return parsed.map((p) => ({
    ...p,
    enabled: ctx.enabled,
    jarPath: ctx.jarPath,
    fileName: ctx.fileName,
    sizeBytes: ctx.sizeBytes,
    instance: ctx.instance,
  }));
}

function stripJarExt(name: string): string {
  return name.replace(/\.jar(\.disabled)?$/i, '');
}

/**
 * Scan every detected launcher instance's `mods/` folder and return one entry
 * per mod declared in each jar (a single jar can declare multiple `[[mods]]`).
 * The same jar present in two instances yields two entries — they differ by
 * `instance`. Best-effort: unreadable jars degrade to a filename-only entry and
 * a missing `mods/` dir is skipped.
 */
export async function listInstalledMinecraftMods(): Promise<InstalledMinecraftMod[]> {
  const out: InstalledMinecraftMod[] = [];
  for (const inst of detectMinecraftInstances()) {
    const entries = await fsp
      .readdir(inst.modsDir, { withFileTypes: true })
      .catch(() => null);
    if (!entries) continue; // mods/ may not exist until first launch
    for (const e of entries) {
      if (!e.isFile()) continue;
      const lower = e.name.toLowerCase();
      const enabled = lower.endsWith('.jar');
      const disabled = lower.endsWith('.jar.disabled');
      if (!enabled && !disabled) continue;
      const jarPath = path.join(inst.modsDir, e.name);
      const sizeBytes = await fsp
        .stat(jarPath)
        .then((s) => s.size)
        .catch(() => 0);
      out.push(
        ...(await readModsFromJar({
          jarPath,
          fileName: e.name,
          fileNameStem: stripJarExt(e.name),
          sizeBytes,
          enabled,
          instance: { launcher: inst.launcher, name: inst.name },
        })),
      );
    }
  }
  return out;
}

/**
 * Resolve a single installed mod for inspection. Prefers an exact `modId`
 * match (enabled before disabled), then falls back to a substring match on id
 * or display name. Returns null when nothing matches.
 */
export async function findInstalledMinecraftMod(
  query: string,
): Promise<InstalledMinecraftMod | null> {
  const all = await listInstalledMinecraftMods();
  const q = query.trim().toLowerCase();
  const exact = all.filter((m) => m.modId.toLowerCase() === q);
  const matches = exact.length
    ? exact
    : all.filter(
        (m) =>
          m.modId.toLowerCase().includes(q) ||
          m.displayName.toLowerCase().includes(q),
      );
  if (matches.length === 0) return null;
  matches.sort((a, b) => Number(b.enabled) - Number(a.enabled));
  return matches[0];
}

/**
 * True when `jarPath` resolves inside one of the detected instance `mods/`
 * dirs. Used to bound an explicit `jarPath` argument to inspect_mod — those
 * launcher dirs are deliberately NOT in the agent's path-policy allowlist (only
 * the extraction cache is), so this is the gate for a model-supplied path.
 */
export function isPathInsideModsDir(jarPath: string): boolean {
  const abs = path.resolve(jarPath);
  return detectMinecraftInstances().some((i) => {
    const rel = path.relative(i.modsDir, abs);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}
