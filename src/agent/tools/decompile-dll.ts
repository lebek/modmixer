import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertPathAllowed } from '../security/path-policy.js';
import { getPathPolicyRoots } from '../security/policy-roots.js';

const Params = Type.Object({
  dllPath: Type.String({
    description: 'Absolute path to the .dll to decompile.',
  }),
  type: Type.Optional(
    Type.String({
      description:
        'Optional fully-qualified type name to decompile a single class (faster, smaller output). Example: "MyMod.Patches.Pawn_HealthTracker_Patch". Omit to decompile the whole assembly.',
    }),
  ),
});

export interface DecompileDllDetails {
  output: string;
  truncated: boolean;
  exitCode: number;
}

const MAX_OUTPUT = 100 * 1024;
const INSTALL_HINT =
  'ilspycmd is not installed. Install it with:\n\n  dotnet tool install -g ilspycmd\n\nThen ensure ~/.dotnet/tools is on PATH and retry.';

export const decompileDllTool: AgentTool<typeof Params, DecompileDllDetails> = {
  name: 'decompile_dll',
  label: 'Decompile DLL',
  description:
    'Decompile a .NET DLL with ilspycmd to read its C# source. Use to investigate what a mod does at runtime — Harmony patches, Mod entrypoints, custom Defs. Pass `type` to decompile a single class for faster, smaller output. Requires ilspycmd (dotnet tool install -g ilspycmd).',
  parameters: Params,
  async execute(_id, params, signal): Promise<AgentToolResult<DecompileDllDetails>> {
    // Bound the prompt-injection blast radius: a hostile mod's About.xml or
    // README cannot make us decompile system DLLs, browser binaries, or
    // anything outside the modmixer workspace and known RimWorld install.
    const safeDllPath = assertPathAllowed(
      params.dllPath,
      getPathPolicyRoots(),
      'dllPath',
    );
    if (!fs.existsSync(safeDllPath)) {
      throw new Error(`DLL not found: ${safeDllPath}`);
    }

    const ilspycmd = resolveIlspycmd();
    if (!ilspycmd) {
      return {
        content: [{ type: 'text', text: INSTALL_HINT }],
        details: { output: '', truncated: false, exitCode: -1 },
      };
    }

    const args = params.type
      ? ['-t', params.type, safeDllPath]
      : [safeDllPath];
    const result = await runCommand(ilspycmd, args, signal);

    let output = result.stdout || result.stderr || '(empty output)';
    let truncated = false;
    if (output.length > MAX_OUTPUT) {
      const cut = output.slice(0, MAX_OUTPUT);
      output =
        cut +
        `\n\n... (truncated; full output was ${result.stdout.length} bytes. Pass the "type" param to scope to a single class, or use grep on the file path.)`;
      truncated = true;
    }

    return {
      content: [{ type: 'text', text: output }],
      details: { output, truncated, exitCode: result.exitCode },
    };
  },
};

function resolveIlspycmd(): string | null {
  const exe = process.platform === 'win32' ? 'ilspycmd.exe' : 'ilspycmd';
  const home = os.homedir();
  const candidates: string[] = [path.join(home, '.dotnet', 'tools', exe)];
  if (process.env.DOTNET_CLI_HOME) {
    candidates.push(
      path.join(process.env.DOTNET_CLI_HOME, '.dotnet', 'tools', exe),
    );
  }
  // Walk PATH ourselves so tilde'd entries (e.g. literal "~/.dotnet/tools")
  // still resolve — Node's spawn doesn't expand ~.
  const pathEnv = process.env.PATH ?? '';
  for (const entry of pathEnv.split(path.delimiter)) {
    if (!entry) continue;
    const expanded = entry.startsWith('~')
      ? path.join(home, entry.slice(1))
      : entry;
    candidates.push(path.join(expanded, exe));
  }
  for (const c of candidates) {
    try {
      // X_OK isn't meaningful on Windows — fall back to existence check there.
      const mode =
        process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
      fs.accessSync(c, mode);
      return c;
    } catch {
      // try next
    }
  }
  return null;
}

function runCommand(
  cmd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
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
        stderr:
          stderr + (err instanceof Error ? err.message : String(err)),
      });
    });
  });
}
