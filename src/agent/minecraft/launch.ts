import { app } from 'electron';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { spawnGradle, type GradleRun } from './gradle.js';
import { ensureModmixerWiring } from './scaffold.js';
import { BRIDGE_PORT } from '../monitor/protocol.js';

/**
 * Launching a Minecraft mod for the agent's test loop. Unlike RimWorld (Steam +
 * a symlinked Mods/ folder), the dev test loop runs the modded client straight
 * out of the project with `./gradlew runClient` — no launcher, no install. The
 * ModMixer NeoForge bridge mod is loaded alongside the user's mod and streams
 * aggregated errors back to the same monitor server the RimWorld bridge uses
 * (127.0.0.1:BRIDGE_PORT).
 *
 * Two pieces of Gradle wiring live in the scaffolded project's build.gradle
 * (appended by minecraft/scaffold.ts) and must be validated on a real machine:
 *  1. the runClient run loads the bridge jar passed as -PmodmixerBridgeJar; and
 *  2. it forwards `-Dmodmixer.*` system properties to the game JVM so the bridge
 *     can read the port/timeout.
 * Those are marked VERIFY in the scaffold snippet.
 */

let activeClient: { child: ChildProcess; projectDir: string } | null = null;

export function isMinecraftClientRunning(): boolean {
  return (
    activeClient !== null &&
    activeClient.child.exitCode === null &&
    !activeClient.child.killed
  );
}

/** Kill a runClient left over from a prior cycle. Returns true if one was running. */
export async function quitMinecraftClient(): Promise<boolean> {
  if (!activeClient) return false;
  const { child } = activeClient;
  activeClient = null;
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  return true;
}

/**
 * Resolve the prebuilt ModMixer bridge mod jar. Built in CI / via a build step
 * from vendor/modmixer-bridge-neoforge and shipped in resources; in the dev tree
 * it's the gradle build output. Throws a clear, actionable error when absent so
 * the test loop fails loudly rather than launching without diagnostics.
 */
export function resolveBridgeJar(): string {
  const shipped = [
    path.join(process.resourcesPath ?? '', 'modmixer-bridge.jar'),
    path.join(app.getAppPath(), 'resources', 'modmixer-bridge.jar'),
  ];
  for (const p of shipped) {
    if (p && fs.existsSync(p)) return p;
  }
  // Dev tree: the gradle build output of the vendored bridge project.
  const libs = path.join(
    app.getAppPath(),
    'vendor',
    'modmixer-bridge-neoforge',
    'build',
    'libs',
  );
  try {
    const jar = fs
      .readdirSync(libs)
      .find((f) => f.endsWith('.jar') && !f.endsWith('-sources.jar'));
    if (jar) return path.join(libs, jar);
  } catch {
    /* not built yet */
  }
  throw new Error(
    'The Minecraft diagnostics bridge jar is not built. Run `npm run build:bridge` ' +
      '(builds vendor/modmixer-bridge-neoforge) so run_test_cycle can stream errors back.',
  );
}

export interface MinecraftLaunchOptions {
  /** Wall-clock cap; the bridge auto-exits the client after this (ms). */
  testTimeoutMs?: number;
  /**
   * Absolute paths to already-installed mod jars to load into the dev client
   * alongside the user's mod (compat testing). Added to the run's runtime
   * classpath the same way the bridge jar is, so FML discovers them.
   */
  extraMods?: string[];
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

/**
 * Launch the modded client via `./gradlew runClient`, wired so the bridge mod
 * connects back to the monitor on BRIDGE_PORT. Returns the live run; the caller
 * arms the monitor (which the bridge connects to) before/around this.
 */
export async function launchMinecraftClient(
  projectDir: string,
  opts: MinecraftLaunchOptions = {},
): Promise<GradleRun> {
  await quitMinecraftClient();
  // Self-heal the build.gradle wiring so a mod scaffolded before a given wiring
  // version still gets the bridge + companion classpath hooks on next launch.
  await ensureModmixerWiring(path.join(projectDir, 'build.gradle'));
  const bridgeJar = resolveBridgeJar();
  const args = [
    `-PmodmixerBridgeJar=${bridgeJar}`,
    `-Dmodmixer.port=${BRIDGE_PORT}`,
  ];
  if (opts.testTimeoutMs) {
    args.push(`-Dmodmixer.testTimeoutMs=${opts.testTimeoutMs}`);
  }
  // Pass extra mod jars as a single platform-delimited list (path.delimiter ===
  // java.io.File.pathSeparator per-platform, which the Gradle snippet splits on).
  const extraMods = (opts.extraMods ?? []).filter((p) => p.trim().length > 0);
  if (extraMods.length > 0) {
    args.push(`-PmodmixerExtraMods=${extraMods.join(path.delimiter)}`);
  }
  const run = await spawnGradle(projectDir, {
    tasks: ['runClient'],
    args,
    onLine: opts.onLine,
    signal: opts.signal,
  });
  activeClient = { child: run.child, projectDir };
  run.done.finally(() => {
    if (activeClient?.child === run.child) activeClient = null;
  });
  return run;
}
