import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { getWorkspacePaths } from '../workspace.js';
import { lintMod, formatFindings, type LintFinding } from '../build-lint.js';
import { DOTNET_NOT_FOUND_MESSAGE, resolveDotnet } from '../dotnet.js';

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
}

export const buildModTool: AgentTool<typeof Params, BuildModDetails> = {
  name: 'build_mod',
  label: 'Build mod',
  description:
    "Run `dotnet build` in the mod's Source/ directory. Returns the full build output (errors, warnings, success summary) so you can read compile errors and fix them. Requires .NET SDK to be installed and a .csproj to exist in Source/.",
  parameters: Params,
  async execute(_id, params, signal): Promise<AgentToolResult<BuildModDetails>> {
    const { workspaceDir } = getWorkspacePaths();
    const modDir = path.join(workspaceDir, params.modFolder);
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
    const status =
      result.exitCode === 0
        ? 'BUILD SUCCEEDED'
        : `BUILD FAILED (exit ${result.exitCode})`;
    const text =
      `${status}\n\n${result.stdout}${
        result.stderr ? '\n--- stderr ---\n' + result.stderr : ''
      }` + formatFindings(lintFindings);
    return {
      content: [{ type: 'text', text }],
      details: { ...result, sourceDir, lintFindings },
    };
  },
};

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
