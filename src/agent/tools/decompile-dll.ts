import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
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
  listTypes: Type.Optional(
    Type.Boolean({
      description:
        'If true, list every class/struct/interface/enum/delegate in the assembly (one per line, prefixed with the kind) instead of decompiling. Use this first when you need to drill into an unfamiliar DLL — guessing fully-qualified type names rarely works (e.g. patches are named like "MyMod.MainTabWindowWork_DoWindowContents_Patch" with idiosyncratic underscoring). Mutually exclusive with `type`.',
    }),
  ),
});

export interface DecompileDllDetails {
  output: string;
  truncated: boolean;
  exitCode: number;
}

const MAX_OUTPUT = 100 * 1024;
const LIST_ENTITY_KINDS = 'cised'; // class, interface, struct, enum, delegate
const INSTALL_HINT =
  'ilspycmd is not installed. Install it with:\n\n  dotnet tool install -g ilspycmd\n\nThen ensure ~/.dotnet/tools is on PATH and retry.';

export const decompileDllTool: AgentTool<typeof Params, DecompileDllDetails> = {
  name: 'decompile_dll',
  label: 'Decompile DLL',
  description:
    "Decompile a .NET DLL with ilspycmd to read its C# source. Use for ad-hoc inspection of a third-party mod DLL — for vanilla RimWorld code, prefer the indexed read_symbol / search_source / who_uses_def tools (cheaper and pre-built). ALWAYS use this tool to run ilspycmd; never invoke ilspycmd via bash, because the bash path triggers a user approval prompt while this tool is path-policy-guarded and runs without one. For unfamiliar DLLs start with `listTypes: true` to discover type names, then `type: \"Full.Type.Name\"` to decompile one class. Omitting both falls back to listing types when the full dump would be too large. Requires ilspycmd (dotnet tool install -g ilspycmd).",
  parameters: Params,
  async execute(_id, params, signal): Promise<AgentToolResult<DecompileDllDetails>> {
    if (params.type && params.listTypes) {
      throw new Error('decompile_dll: pass either `type` or `listTypes`, not both.');
    }

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

    const args = params.listTypes
      ? ['-l', LIST_ENTITY_KINDS, safeDllPath]
      : params.type
        ? ['-t', params.type, safeDllPath]
        : [safeDllPath];
    const result = await runIlspycmd(ilspycmd, args, signal);

    let output = result.stdout || result.stderr || '(empty output)';
    let truncated = false;

    // Full-assembly dumps are usually 100KB+ on real mod DLLs and the agent
    // almost always wants to drill into one type. Replace the dump with the
    // type list (typically <5KB) so the next call can be a targeted
    // `type=...`. Errors out of ilspycmd shouldn't trigger this path.
    if (
      !params.type &&
      !params.listTypes &&
      result.exitCode === 0 &&
      output.length > MAX_OUTPUT
    ) {
      const listResult = await runIlspycmd(
        ilspycmd,
        ['-l', LIST_ENTITY_KINDS, safeDllPath],
        signal,
      );
      const list = listResult.stdout?.trim() || '(no types listed)';
      output =
        `Full decompile was ${result.stdout.length} bytes — too large to return. ` +
        `Listing the assembly's types instead; re-call with \`type: "<full.type.name>"\` to inspect a single class.\n\n` +
        list;
      truncated = true;
    } else if (output.length > MAX_OUTPUT) {
      const cut = output.slice(0, MAX_OUTPUT);
      output =
        cut +
        `\n\n... (truncated; full output was ${result.stdout.length} bytes. Pass \`type\` for one class or \`listTypes: true\` to discover names.)`;
      truncated = true;
    }

    return {
      content: [{ type: 'text', text: output }],
      details: { output, truncated, exitCode: result.exitCode },
    };
  },
};

