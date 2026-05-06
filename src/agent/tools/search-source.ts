import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { getIndexPaths } from '../index/paths.js';
import { getIndexStatus } from '../index/rebuild.js';

const Params = Type.Object({
  query: Type.String({
    description:
      'Regex pattern (ripgrep syntax) to search for in the decompiled RimWorld source. Anchor with `\\b` for whole-word matches.',
  }),
  caseSensitive: Type.Optional(
    Type.Boolean({ description: 'Match case (default false).' }),
  ),
  filePattern: Type.Optional(
    Type.String({
      description:
        'Glob to restrict matches (e.g. "**/RimWorld/*.cs" or "**/Verse/AI/*.cs"). Default: every .cs file under the source corpus.',
    }),
  ),
  maxLines: Type.Optional(
    Type.Number({
      description: 'Hard cap on total result lines (default 200, max 800).',
    }),
  ),
});

const NO_INDEX_MSG =
  'RimWorld source index is not built yet (or built without C# decompile). Open Settings → RimWorld index → Rebuild.';

const MAX_OUTPUT_BYTES = 64 * 1024;

let cachedRgPath: string | null | undefined;
function resolveRipgrep(): string | null {
  if (cachedRgPath !== undefined) return cachedRgPath;
  // Prefer the regular module require (works in dev). Fall back to the
  // resourcesPath copy that Forge ships in packaged builds.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@vscode/ripgrep') as { rgPath: string };
    cachedRgPath = mod.rgPath;
    return cachedRgPath;
  } catch {
    // try packaged path next
  }
  try {
    const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
    cachedRgPath = path.join(
      process.resourcesPath,
      'ripgrep',
      'bin',
      exe,
    );
  } catch {
    cachedRgPath = null;
  }
  return cachedRgPath;
}

export const searchSourceTool: AgentTool<typeof Params, { matchedLines: number; truncated: boolean }> = {
  name: 'search_source',
  label: 'Search RimWorld source',
  description:
    'Ripgrep over the decompiled RimWorld C# source. Use for finding call sites ("StealAIUtility\\\\b"), patch targets, or any pattern that isn\'t a clean type/method name. For symbol-level lookup prefer read_csharp_symbol — search_source returns line hits across the whole corpus.',
  parameters: Params,
  async execute(_id, params, signal): Promise<AgentToolResult<{ matchedLines: number; truncated: boolean }>> {
    const status = getIndexStatus();
    if (status.type === 'absent' || status.type === 'no-rimworld') {
      return {
        content: [{ type: 'text', text: NO_INDEX_MSG }],
        details: { matchedLines: 0, truncated: false },
      };
    }
    const { sourceRoot } = getIndexPaths();
    const rg = resolveRipgrep();
    if (!rg) {
      return {
        content: [
          {
            type: 'text',
            text:
              'Ripgrep is missing from this build. Reinstall modmixer or run `npm install` to fetch @vscode/ripgrep.',
          },
        ],
        details: { matchedLines: 0, truncated: false },
      };
    }

    const args = [
      '--line-number',
      '--heading',
      '--color',
      'never',
      '--max-filesize',
      '1M',
      params.caseSensitive ? '-s' : '-i',
    ];
    if (params.filePattern) args.push('-g', params.filePattern);
    // Pass `sourceRoot` as the search path (rather than '.' with cwd=sourceRoot)
    // so ripgrep's `--heading` output prints absolute file paths. The agent's
    // `read` tool can pass those straight through; relative paths would have
    // resolved against the agent cwd (the mod workspace) and 404'd, which used
    // to push the model into hallucinating a `.cache/rimworld-source/...`
    // prefix.
    args.push('-e', params.query, sourceRoot);

    const result = await runRg(rg, args, sourceRoot, signal);

    const maxLines = Math.min(Math.max(params.maxLines ?? 200, 1), 800);
    let truncated = result.truncatedBytes;
    let output = result.stdout;
    const lines = output.split(/\r?\n/);
    let matchedLines = 0;
    for (const ln of lines) {
      if (/^\d+:/.test(ln)) matchedLines++;
    }
    if (lines.length > maxLines) {
      output =
        lines.slice(0, maxLines).join('\n') +
        `\n\n[truncated: showing ${maxLines}/${lines.length} lines — refine the query or pass a tighter filePattern]`;
      truncated = true;
    } else if (truncated) {
      output += `\n\n[truncated: output exceeded ${MAX_OUTPUT_BYTES} bytes]`;
    }

    if (matchedLines === 0) {
      return {
        content: [
          { type: 'text', text: `No matches for /${params.query}/${params.caseSensitive ? '' : 'i'}.` },
        ],
        details: { matchedLines: 0, truncated: false },
      };
    }

    return {
      content: [{ type: 'text', text: output }],
      details: { matchedLines, truncated },
    };
  },
};

interface RgRunResult {
  stdout: string;
  truncatedBytes: boolean;
  exitCode: number;
}

function runRg(
  exe: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<RgRunResult> {
  return new Promise((resolve) => {
    const proc = spawn(exe, args, { cwd });
    let stdout = '';
    let truncatedBytes = false;
    let totalBytes = 0;
    proc.stdout?.on('data', (d: Buffer) => {
      if (truncatedBytes) return;
      const next = totalBytes + d.byteLength;
      if (next > MAX_OUTPUT_BYTES) {
        const remain = MAX_OUTPUT_BYTES - totalBytes;
        if (remain > 0) stdout += d.subarray(0, remain).toString('utf8');
        truncatedBytes = true;
        try {
          proc.kill();
        } catch {
          // ignore
        }
        return;
      }
      totalBytes = next;
      stdout += d.toString('utf8');
    });
    const onAbort = () => proc.kill();
    signal?.addEventListener('abort', onAbort);
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, truncatedBytes, exitCode: code ?? -1 });
    });
    proc.on('error', () => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, truncatedBytes, exitCode: -1 });
    });
  });
}
