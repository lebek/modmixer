import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { getWorkspacePaths } from '../workspace.js';
import { lintMod, formatFindings, type LintFinding } from '../build-lint.js';
import {
  extractHints,
  formatHints,
  type BuildErrorHint,
} from '../build-error-hints.js';
import { DOTNET_NOT_FOUND_MESSAGE, resolveDotnet } from '../dotnet.js';
import { launchModeHint } from '../launch-mode.js';
import { readModPrefs } from '../mod-prefs.js';
import { buildMod as buildMinecraftMod } from '../minecraft/gradle.js';

const Params = Type.Object({
  modFolder: Type.String({
    description: 'Mod folder name relative to Mods/, e.g. "HelloWorld".',
  }),
});

export interface BuildModDetails {
  exitCode: number;
  stdout: string;
  stderr: string;
  sourceDir: string;
  /**
   * Non-fatal RimWorld-specific lint findings (e.g. CompTickRare without
   * tickerType). These are advisory — they do not affect the build's
   * exit code.
   */
  lintFindings: LintFinding[];
  /**
   * For failed builds: per-error suggestions resolved against the C# index
   * (e.g. "missing `using RimWorld.Planet;` for IsWorldPawn"). Empty when
   * the index can't help — never blocks anything.
   */
  errorHints: BuildErrorHint[];
}

export const buildModTool: AgentTool<typeof Params, BuildModDetails> = {
  name: 'build_mod',
  label: 'Build mod',
  description:
    "Compile the mod and return the full build output (errors, warnings, success summary) so you can read compile errors and fix them. RimWorld mods run `dotnet build` in Source/ (needs the .NET SDK + a .csproj). Minecraft (NeoForge) mods run `./gradlew build` in the project root (the first build decompiles Minecraft and can take several minutes).",
  parameters: Params,
  async execute(_id, params, signal): Promise<AgentToolResult<BuildModDetails>> {
    const { workspaceDir } = getWorkspacePaths();
    const modDir = path.join(workspaceDir, params.modFolder);
    const prefs = await readModPrefs(params.modFolder);
    if (prefs.game === 'minecraft') {
      return buildMinecraftWithGradle(modDir, signal);
    }
    const sourceDir = path.join(modDir, 'Source');
    if (!fs.existsSync(sourceDir)) {
      throw new Error(
        `Source folder not found: ${sourceDir}. Use scaffold_mod with withCSharp=true or write a .csproj first.`,
      );
    }
    const dotnet = resolveDotnet();
    if (!dotnet) {
      throw new Error(DOTNET_NOT_FOUND_MESSAGE);
    }
    const result = await runCommand(
      dotnet,
      ['build', '--nologo'],
      sourceDir,
      signal,
    );
    // Run lints even on a failed build — most lint findings (tickerType,
    // wrong TFM) are diagnoseable from source alone, and surfacing them
    // alongside compile errors gives the agent a head start.
    let lintFindings: LintFinding[] = [];
    try {
      lintFindings = await lintMod(modDir);
    } catch (err) {
      // Lint failures should never block the build; log and continue.
      console.warn('[build_mod] lint failed:', err);
    }
    // For failed builds, try to resolve any "missing using" errors against
    // the C# symbol index so the agent doesn't have to grep for it. Hints
    // are best-effort — we swallow any failure rather than masking the
    // build error itself.
    let errorHints: BuildErrorHint[] = [];
    if (result.exitCode !== 0) {
      try {
        errorHints = extractHints(result.stdout, modDir);
      } catch (err) {
        console.warn('[build_mod] hint extraction failed:', err);
      }
    }
    const status =
      result.exitCode === 0
        ? 'BUILD SUCCEEDED'
        : `BUILD FAILED (exit ${result.exitCode})`;
    const text =
      `${status}\n\n${result.stdout}${
        result.stderr ? '\n--- stderr ---\n' + result.stderr : ''
      }` +
      formatFindings(lintFindings) +
      formatHints(errorHints) +
      // Only on a green build: a red build's next step is fixing errors, not
      // testing, so a launch reminder there is just noise. The hint itself is
      // worded to NOT imply the green build means "ready to test".
      (result.exitCode === 0 ? launchModeHint() : '');
    return {
      content: [{ type: 'text', text }],
      details: { ...result, sourceDir, lintFindings, errorHints },
    };
  },
};

/**
 * Minecraft mods are Gradle/NeoForge projects: the mod folder *is* the Gradle
 * project root (no Source/ subdir), built with `./gradlew build`. The first
 * build decompiles Minecraft and can take many minutes — that's expected.
 */
async function buildMinecraftWithGradle(
  modDir: string,
  signal?: AbortSignal,
): Promise<AgentToolResult<BuildModDetails>> {
  const hasWrapper =
    fs.existsSync(path.join(modDir, 'gradlew')) ||
    fs.existsSync(path.join(modDir, 'gradlew.bat'));
  if (!hasWrapper) {
    throw new Error(
      `No Gradle wrapper in ${modDir}. Use scaffold_mod to lay down the NeoForge project first.`,
    );
  }
  const result = await buildMinecraftMod(modDir, undefined, signal);
  const exitCode = result.ok ? 0 : 1;
  const status = result.ok
    ? `BUILD SUCCEEDED${result.jarPath ? ` → ${result.jarPath}` : ''}`
    : 'BUILD FAILED';
  return {
    content: [{ type: 'text', text: `${status}\n\n${result.output}` }],
    details: {
      exitCode,
      stdout: result.output,
      stderr: '',
      sourceDir: modDir,
      lintFindings: [],
      errorHints: [],
    },
  };
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const onAbort = () => proc.kill();
    signal?.addEventListener('abort', onAbort);
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + (err instanceof Error ? err.message : String(err)),
      });
    });
  });
}
