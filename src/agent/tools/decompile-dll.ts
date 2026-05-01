import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import fs from 'node:fs';
import { assertPathAllowed } from '../security/path-policy.js';
import { getPathPolicyRoots } from '../security/policy-roots.js';
import { resolveIlspycmd, runIlspycmd } from '../index/ilspycmd.js';

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
    const result = await runIlspycmd(ilspycmd, args, signal);

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

