import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureJdk21, jdkEnv } from './jdk.js';

/**
 * Driving Gradle for NeoForge mods. The project's gradlew *wrapper* downloads
 * the correct Gradle version on first run, so the only thing we provide is a
 * JDK 21 (via JAVA_HOME). The very first invocation also decompiles Minecraft
 * and can take many minutes — callers should surface progress.
 */

function gradlewPath(projectDir: string): string {
  return path.join(projectDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
}

/** Ensure the POSIX wrapper is executable (a Windows checkout can drop +x). */
async function ensureExecutable(file: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    await fsp.chmod(file, 0o755);
  } catch {
    /* best effort */
  }
}

export interface GradleRun {
  child: ChildProcess;
  /** Resolves when the process exits. */
  done: Promise<{ code: number | null; output: string }>;
}

export interface SpawnGradleOptions {
  /** Gradle tasks, e.g. ['build'] or ['runClient']. */
  tasks: string[];
  /** Extra args appended after tasks, e.g. ['-Dmodmixer.port=13371']. */
  args?: string[];
  /** Called for each line of combined stdout/stderr as it streams. */
  onLine?: (line: string) => void;
  /** JDK home to run under; resolved via ensureJdk21() when omitted. */
  javaHome?: string;
  /** Abort signal — killing the Gradle process when the tool call is cancelled. */
  signal?: AbortSignal;
}

/**
 * Spawn a Gradle task and return the live child plus a completion promise. Used
 * for both the fire-and-forget build and the long-lived runClient (the bridge
 * monitor manages the latter's lifetime).
 */
export async function spawnGradle(
  projectDir: string,
  opts: SpawnGradleOptions,
): Promise<GradleRun> {
  const wrapper = gradlewPath(projectDir);
  if (!fs.existsSync(wrapper)) {
    throw new Error(`No Gradle wrapper at ${wrapper} — is this a NeoForge project?`);
  }
  await ensureExecutable(wrapper);
  const home = opts.javaHome ?? (await ensureJdk21()).home;

  const child = spawn(wrapper, [...opts.tasks, ...(opts.args ?? [])], {
    cwd: projectDir,
    env: jdkEnv(home),
    // On Windows the .bat needs a shell; on POSIX we exec the wrapper directly.
    shell: process.platform === 'win32',
  });
  if (opts.signal) {
    const onAbort = () => child.kill();
    opts.signal.addEventListener('abort', onAbort, { once: true });
    child.on('close', () => opts.signal?.removeEventListener('abort', onAbort));
  }

  let output = '';
  let pending = '';
  const handle = (buf: Buffer) => {
    const text = buf.toString();
    output += text;
    if (!opts.onLine) return;
    pending += text;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) opts.onLine(line);
  };
  child.stdout?.on('data', handle);
  child.stderr?.on('data', handle);

  const done = new Promise<{ code: number | null; output: string }>((resolve) => {
    child.on('close', (code) => {
      if (pending && opts.onLine) opts.onLine(pending);
      resolve({ code, output });
    });
    child.on('error', (err) => {
      output += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: -1, output });
    });
  });

  return { child, done };
}

export interface BuildResult {
  ok: boolean;
  /** Path to the built mod jar (build/libs/<id>-<ver>.jar), if produced. */
  jarPath: string | null;
  /** Full combined Gradle output (for the agent / error hints). */
  output: string;
}

/** Locate the primary mod jar under build/libs, ignoring -sources/-javadoc jars. */
async function findOutputJar(projectDir: string): Promise<string | null> {
  const libs = path.join(projectDir, 'build', 'libs');
  let entries: string[];
  try {
    entries = await fsp.readdir(libs);
  } catch {
    return null;
  }
  const jars = entries.filter(
    (f) => f.endsWith('.jar') && !f.endsWith('-sources.jar') && !f.endsWith('-javadoc.jar'),
  );
  if (jars.length === 0) return null;
  // Prefer the most recently written jar.
  const withMtime = await Promise.all(
    jars.map(async (f) => ({
      file: path.join(libs, f),
      mtime: (await fsp.stat(path.join(libs, f))).mtimeMs,
    })),
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime[0].file;
}

/** Compile a NeoForge mod: `./gradlew build` → build/libs/<mod>.jar. */
export async function buildMod(
  projectDir: string,
  onLine?: (line: string) => void,
  signal?: AbortSignal,
): Promise<BuildResult> {
  const run = await spawnGradle(projectDir, { tasks: ['build'], onLine, signal });
  const { code, output } = await run.done;
  const jarPath = code === 0 ? await findOutputJar(projectDir) : null;
  return { ok: code === 0 && jarPath !== null, jarPath, output };
}
