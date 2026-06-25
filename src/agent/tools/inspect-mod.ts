import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { modCacheRoot } from '../index/paths.js';
import { extractJarInto } from '../index/minecraft-source.js';
import { decompileJar } from '../index/vineflower.js';
import {
  findInstalledMinecraftMod,
  listInstalledMinecraftMods,
  isPathInsideModsDir,
  type InstalledMinecraftMod,
} from '../minecraft/mods-registry.js';

const Params = Type.Object({
  modId: Type.Optional(
    Type.String({
      description:
        'The mod to inspect, by id (preferred) or a display-name substring — resolved against list_installed_mods. Example: "create".',
    }),
  ),
  jarPath: Type.Optional(
    Type.String({
      description:
        'Alternative to modId: an absolute path to a mod .jar. Must live inside a detected launcher mods/ folder. Use modId unless you have a specific jar in mind.',
    }),
  ),
  force: Type.Optional(
    Type.Boolean({
      description:
        'Re-extract and re-decompile even if a fresh cache exists. Defaults to false (reuses the cache when the jar is unchanged).',
    }),
  ),
});
type ParamsT = typeof Params;

export interface InspectModDetails {
  modId: string;
  version: string;
  loader: string;
  cacheDir: string;
  decompiled: boolean;
  javaFiles: number;
}

const RESOURCE_PREFIXES = ['META-INF/', 'data/', 'assets/', 'pack.mcmeta'];

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || 'mod';
}

interface CacheMarker {
  jarPath: string;
  size: number;
  mtimeMs: number;
  version: string;
}

async function readMarker(file: string): Promise<CacheMarker | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as CacheMarker;
  } catch {
    return null;
  }
}

/** Collect up to `cap` relative .java paths under `dir` (depth-first). */
async function walkJava(dir: string, cap = 400): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0 && out.length < cap) {
    const rel = stack.pop() as string;
    const abs = path.join(dir, rel);
    const entries = await fsp.readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) stack.push(childRel);
      else if (e.name.endsWith('.java')) {
        out.push(childRel);
        if (out.length >= cap) break;
      }
    }
  }
  return out;
}

/** Immediate subdirectory names under `dir` (the namespaces of data/ or assets/). */
async function subdirs(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** Files matching `suffix` at the jar root (mixins configs live there). */
async function rootFilesMatching(dir: string, suffix: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(suffix))
    .map((e) => e.name);
}

/** Shortest few package dirs that contain .java — the mod's base packages. */
function topPackages(javaRel: string[], max = 12): string[] {
  const pkgs = new Set<string>();
  for (const rel of javaRel) {
    const dir = path.dirname(rel);
    if (dir !== '.') pkgs.add(dir);
  }
  return [...pkgs]
    .sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b))
    .slice(0, max);
}

function depSummary(mod: InstalledMinecraftMod): string {
  const reqs = mod.dependencies.filter((d) => d.type === 'required');
  if (reqs.length === 0) return '(none declared)';
  return reqs
    .map((d) => (d.versionRange ? `${d.modId} ${d.versionRange}` : d.modId))
    .join(', ');
}

async function buildMap(
  mod: InstalledMinecraftMod,
  cacheDir: string,
  decompiled: boolean,
  javaFiles: number,
  decompileLog: string,
): Promise<string> {
  const sourceDir = path.join(cacheDir, 'Source');
  const javaRel = decompiled ? await walkJava(sourceDir) : [];
  const packages = topPackages(javaRel);
  const mixins = await rootFilesMatching(cacheDir, '.mixins.json');
  const dataNs = await subdirs(path.join(cacheDir, 'data'));
  const assetNs = await subdirs(path.join(cacheDir, 'assets'));

  const lines: string[] = [];
  lines.push(`${mod.displayName} (${mod.modId}) v${mod.version} — loader: ${mod.loader}`);
  if (mod.authors) lines.push(`Authors: ${mod.authors}`);
  if (mod.description) lines.push(`Description: ${mod.description.split('\n')[0]}`);
  lines.push(`Requires: ${depSummary(mod)}`);
  lines.push('');
  lines.push(`Cracked open at: ${cacheDir}`);
  lines.push('Explore it with the normal grep / find / read tools. Layout:');

  if (decompiled) {
    lines.push(`  Source/        decompiled Java — ${javaFiles} .java file(s)`);
    if (packages.length) {
      lines.push('    packages:');
      for (const p of packages) lines.push(`      Source/${p}/`);
    }
  } else {
    lines.push('  Source/        (decompile unavailable — see note below)');
  }
  if (mixins.length) lines.push(`  mixins:        ${mixins.join(', ')}`);
  if (dataNs.length) lines.push(`  data/          namespaces: ${dataNs.join(', ')}`);
  if (assetNs.length) lines.push(`  assets/        namespaces: ${assetNs.join(', ')}`);

  lines.push('');
  if (decompiled) {
    lines.push(
      'Tip: grep Source/ for "@Mod(" to find the entry point, then read the class. ' +
        'Mod calls into vanilla use the same net.minecraft.* names search_source/read_symbol index.',
    );
  } else {
    lines.push(
      'Note: could not decompile this jar (the metadata + data/assets above are still readable). ' +
        `Decompiler log:\n${decompileLog}`,
    );
  }
  return lines.join('\n');
}

export const inspectModTool: AgentTool<ParamsT, InspectModDetails> = {
  name: 'inspect_mod',
  label: 'Inspect installed mod',
  description:
    "Crack open an installed Minecraft mod jar so you can read how it works: extracts its data/assets JSON + manifest and decompiles its compiled classes (Vineflower) into a readable cache folder, then returns a map of that folder. After this, use the ordinary grep/find/read tools on the returned path to study the mod's source and data — the Minecraft analog of decompile_dll. Resolve the mod by `modId` (from list_installed_mods). Re-running is cheap (cached unless the jar changed). The first call may take a minute (it provisions Java 21 on first use, then decompiles).",
  parameters: Params,
  async execute(_id, params, signal): Promise<AgentToolResult<InspectModDetails>> {
    // Resolve the target jar + metadata.
    let mod: InstalledMinecraftMod | null = null;
    if (params.modId) {
      mod = await findInstalledMinecraftMod(params.modId);
      if (!mod) {
        throw new Error(
          `No installed mod matches "${params.modId}". Call list_installed_mods to see what's installed.`,
        );
      }
    } else if (params.jarPath) {
      if (!isPathInsideModsDir(params.jarPath)) {
        throw new Error(
          `jarPath must be inside a detected launcher mods/ folder. Prefer passing modId instead.`,
        );
      }
      const all = await listInstalledMinecraftMods();
      mod =
        all.find((m) => path.resolve(m.jarPath) === path.resolve(params.jarPath as string)) ??
        null;
      if (!mod) {
        throw new Error(
          `Could not read a mod manifest from ${params.jarPath}. Use modId from list_installed_mods.`,
        );
      }
    } else {
      throw new Error('Pass `modId` (preferred) or `jarPath` to identify the mod to inspect.');
    }

    const cacheDir = path.join(modCacheRoot(), 'minecraft', sanitize(mod.modId));
    const markerPath = path.join(cacheDir, '.mm-cache.json');
    const stat = await fsp.stat(mod.jarPath).catch(() => null);
    if (!stat) {
      throw new Error(`Mod jar no longer exists at ${mod.jarPath}.`);
    }

    // Reuse the cache when the jar is byte-identical (size+mtime) unless forced.
    const marker = await readMarker(markerPath);
    const fresh =
      !params.force &&
      marker !== null &&
      marker.size === stat.size &&
      marker.mtimeMs === stat.mtimeMs;

    let decompiled: boolean;
    let javaFiles: number;
    let decompileLog = '';

    if (fresh) {
      // Trust the prior build; count what's there for the map.
      const existing = await walkJava(path.join(cacheDir, 'Source'), 1);
      decompiled = existing.length > 0;
      javaFiles = decompiled ? (await walkJava(path.join(cacheDir, 'Source'))).length : 0;
    } else {
      await fsp.rm(cacheDir, { recursive: true, force: true });
      await fsp.mkdir(cacheDir, { recursive: true });
      // Loose resources first (cheap, always works), then decompile classes.
      await extractJarInto(mod.jarPath, cacheDir, RESOURCE_PREFIXES);
      const result = await decompileJar(mod.jarPath, path.join(cacheDir, 'Source'), signal);
      decompiled = result.ok;
      javaFiles = result.javaFiles;
      decompileLog = result.log;
      // Only mark the cache fresh when decompilation succeeded — otherwise a
      // transient failure (Vineflower not yet vendored, JDK still provisioning)
      // would be cached and suppress the retry once the environment is fixed.
      if (decompiled) {
        const newMarker: CacheMarker = {
          jarPath: mod.jarPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          version: mod.version,
        };
        await fsp.writeFile(markerPath, JSON.stringify(newMarker), 'utf8');
      }
    }

    const text = await buildMap(mod, cacheDir, decompiled, javaFiles, decompileLog);
    return {
      content: [{ type: 'text', text }],
      details: {
        modId: mod.modId,
        version: mod.version,
        loader: mod.loader,
        cacheDir,
        decompiled,
        javaFiles,
      },
    };
  },
};
