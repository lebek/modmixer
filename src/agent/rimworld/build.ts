/**
 * RimWorld build: `dotnet build` in the mod's Source/ dir, plus advisory lint
 * findings and (on failure) "missing using" hints resolved against the C#
 * symbol index. Extracted out of tools/build-mod.ts so the build_mod tool is a
 * thin dispatch to getAdapter(game).build() and this RimWorld-specific logic
 * lives in the (newly symmetric) rimworld/ module rather than as the tool's
 * ambient default.
 */
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import { lintMod, formatFindings, type LintFinding } from '../build-lint.js';
import {
  extractHints,
  formatHints,
  type BuildErrorHint,
} from '../build-error-hints.js';
import { findExistingDotnet, dotnetEnv } from '../dotnet-provision.js';
import { launchModeHint } from '../launch-mode.js';
import type { BuildModDetails } from '../adapters/types.js';

export async function buildRimworldMod(
  modDir: string,
  signal?: AbortSignal,
): Promise<AgentToolResult<BuildModDetails>> {
  const sourceDir = path.join(modDir, 'Source');
  const hasCsproj =
    fs.existsSync(sourceDir) &&
    fs.readdirSync(sourceDir).some((f) => f.toLowerCase().endsWith('.csproj'));
  if (!hasCsproj) {
    throw new Error(
      `No C# project in ${sourceDir}. This mod is XML-only — call add_csharp to lay down a buildable Source/ project before building, or skip build_mod entirely for a pure-XML mod.`,
    );
  }
  // Use the SDK that setup already provisioned — never download mid-build (a
  // build silently hanging on a toolchain download is confusing). If it isn't
  // there yet, point the user at setup, which provisions it with visible
  // progress.
  const dotnet = await findExistingDotnet();
  if (!dotnet) {
    throw new Error(
      'The .NET SDK is not set up yet. Open Settings → Games and run RimWorld setup ' +
        '(or click Rebuild) to provision it, then build again.',
    );
  }
  const result = await runCommand(
    dotnet.exe,
    ['build', '--nologo'],
    sourceDir,
    signal,
    dotnetEnv(dotnet),
  );
  // Run lints even on a failed build — most lint findings (tickerType, wrong
  // TFM) are diagnoseable from source alone, and surfacing them alongside
  // compile errors gives the agent a head start.
  let lintFindings: LintFinding[] = [];
  try {
    lintFindings = await lintMod(modDir);
  } catch (err) {
    // Lint failures should never block the build; log and continue.
    console.warn('[build_mod] lint failed:', err);
  }
  // For failed builds, try to resolve any "missing using" errors against the
  // C# symbol index so the agent doesn't have to grep for it. Hints are
  // best-effort — we swallow any failure rather than masking the build error.
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
}

function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, env });
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
