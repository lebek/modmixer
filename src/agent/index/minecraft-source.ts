import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getIndexPaths } from './paths.js';
import { spawnGradle } from '../minecraft/gradle.js';
import { getMinecraftTemplateDir } from '../minecraft/scaffold.js';
import { NEOFORGE_VERSION } from '../minecraft/versions.js';

const execFileP = promisify(execFile);

/**
 * Acquiring the decompiled Minecraft + NeoForge sources for the index. The
 * sources can't be shipped (Mojang license), so we generate them locally with
 * ModDevGradle's `createMinecraftArtifacts` task in a dedicated throwaway
 * project under userData. That task drives NeoFormRuntime to decompile + remap
 * (mojmap) + apply Parchment, producing neoforge-<ver>-sources.jar. The NFRT
 * cache (~/.gradle, ~/.neoformruntime) is shared with mod builds, so after the
 * first decompile this is fast.
 */

/** The index's dedicated Gradle workspace (just to run createMinecraftArtifacts). */
function workspaceDir(): string {
  return path.join(getIndexPaths('minecraft').root, 'workspace');
}

async function ensureWorkspace(): Promise<string> {
  const ws = workspaceDir();
  if (fs.existsSync(path.join(ws, 'build.gradle'))) return ws;
  const template = getMinecraftTemplateDir();
  if (!template) {
    throw new Error(
      'The Minecraft project template is not vendored. Run `npm run fetch:neoforge-mdk`.',
    );
  }
  await fsp.mkdir(path.dirname(ws), { recursive: true });
  await fsp.cp(template, ws, { recursive: true });
  if (process.platform !== 'win32') {
    try {
      await fsp.chmod(path.join(ws, 'gradlew'), 0o755);
    } catch {
      /* best effort */
    }
  }
  return ws;
}

export interface MinecraftArtifacts {
  /** Decompiled, Parchment-mapped MC + NeoForge Java sources. */
  sourcesJar: string;
  /** Merged runtime jar containing vanilla data/minecraft/* JSON. */
  dataJar: string | null;
  /** Client resources jar containing assets/minecraft/* (lang, models). */
  clientResourcesJar: string | null;
}

function findJar(dir: string, suffix: string, exclude: string[] = []): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const hit = entries.find(
    (f) => f.endsWith(suffix) && !exclude.some((e) => f.includes(e)),
  );
  return hit ? path.join(dir, hit) : null;
}

/** Run createMinecraftArtifacts and return the produced artifact jars. */
export async function ensureMinecraftSources(
  onLine?: (line: string) => void,
  signal?: AbortSignal,
): Promise<MinecraftArtifacts> {
  const ws = await ensureWorkspace();
  const run = await spawnGradle(ws, {
    tasks: ['createMinecraftArtifacts'],
    onLine,
    signal,
  });
  const { code, output } = await run.done;
  if (code !== 0) {
    throw new Error(
      `createMinecraftArtifacts failed (exit ${code}):\n${output.slice(-2000)}`,
    );
  }
  const artifacts = path.join(ws, 'build', 'moddev', 'artifacts');
  const sourcesJar =
    findJar(artifacts, `neoforge-${NEOFORGE_VERSION}-sources.jar`) ??
    findJar(artifacts, '-sources.jar');
  if (!sourcesJar) {
    throw new Error(`No -sources.jar produced under ${artifacts}`);
  }
  return {
    sourcesJar,
    dataJar: findJar(artifacts, `neoforge-${NEOFORGE_VERSION}.jar`, [
      '-sources',
      '-merged',
      'client-extra',
    ]),
    clientResourcesJar: findJar(artifacts, 'client-extra-aka-minecraft-resources.jar'),
  };
}

/**
 * Extract a jar into `dest` (wiping it first). Cross-platform: `unzip` on
 * macOS/Linux, bsdtar (`tar -xf`, which handles zip) on Windows. An optional
 * include list limits extraction to those top-level path prefixes (e.g.
 * ['data/', 'assets/']) on platforms where the unzip tool supports globs.
 */
export async function extractJarInto(
  jar: string,
  dest: string,
  includePrefixes?: string[],
): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  if (process.platform === 'win32') {
    // bsdtar can't easily filter; extract all (callers walk what they need).
    await execFileP('tar', ['-xf', jar, '-C', dest], { maxBuffer: 256 * 1024 * 1024 });
  } else {
    const globs = includePrefixes?.map((p) => `${p}*`) ?? [];
    try {
      await execFileP('unzip', ['-q', '-o', jar, ...globs, '-d', dest], {
        maxBuffer: 256 * 1024 * 1024,
      });
    } catch (err) {
      // unzip exit 11 = none of the include globs matched anything in this jar
      // (e.g. a jar with no data/neoforge/). That's expected, not a failure.
      if ((err as { code?: number }).code !== 11) throw err;
    }
  }
}

/** Wipe `dest` then extract (for the sources tree, which is rebuilt wholesale). */
export async function extractJar(
  jar: string,
  dest: string,
  includePrefixes?: string[],
): Promise<void> {
  await fsp.rm(dest, { recursive: true, force: true });
  await extractJarInto(jar, dest, includePrefixes);
}
