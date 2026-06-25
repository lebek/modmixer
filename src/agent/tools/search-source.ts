import { Type } from 'typebox';
import type { TObject } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { getIndexPaths } from '../index/paths.js';
import { resolveRipgrep } from '../index/ripgrep.js';
import type { GameId } from '../games/types.js';

// Type anchor only — the per-game schema (with corpus-specific docs) is supplied
// via spec.params; identical shape keeps `typeof Params` a stable type anchor.
const Params = Type.Object({
  query: Type.String(),
  caseSensitive: Type.Optional(Type.Boolean()),
  filePattern: Type.Optional(Type.String()),
  maxLines: Type.Optional(Type.Number()),
});

const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Per-game presentation for search_source. The ripgrep mechanism is shared; the
 * game's adapter supplies the corpus-specific label, docs, schema, the readiness
 * check, and the human corpus name for the no-matches hint. Lives in
 * `<game>/research-tools.ts`.
 */
export interface SearchSourceSpec {
  label: string;
  description: string;
  params: TObject;
  notReady(): string | null;
  /** Human name of the searched corpus, e.g. "Minecraft + NeoForge Java source". */
  corpusName: string;
}

export function createSearchSourceTool(
  game: GameId,
  spec: SearchSourceSpec,
): AgentTool<typeof Params, { matchedLines: number; truncated: boolean }> {
  return {
  name: 'search_source',
  label: spec.label,
  description: spec.description,
  parameters: spec.params as typeof Params,
  async execute(_id, params, signal): Promise<AgentToolResult<{ matchedLines: number; truncated: boolean }>> {
    const notReady = spec.notReady();
    if (notReady) {
      return {
        content: [{ type: 'text', text: notReady }],
        details: { matchedLines: 0, truncated: false },
      };
    }
    const { sourceRoot, defsRoot } = getIndexPaths(game);
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
    // Pass each root as an absolute search path (rather than '.' with cwd=root)
    // so ripgrep's `--heading` output prints absolute file paths. The agent's
    // `read` tool can pass those straight through; relative paths would have
    // resolved against the agent cwd (the mod workspace) and 404'd, which used
    // to push the model into hallucinating a `.cache/rimworld-source/...`
    // prefix. Both sourceRoot (decompiled C#) and defsRoot (indexed XML) are
    // searched so a single tool call covers vanilla code and the def corpus.
    args.push('-e', params.query, sourceRoot);
    if (fs.existsSync(defsRoot)) args.push(defsRoot);

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
      const flags = params.caseSensitive ? '' : 'i';
      const filterNote = params.filePattern ? ` (filePattern: ${params.filePattern})` : '';
      const hasMeta = /[.[\](){}*+?|^$\\]/.test(params.query);
      const tips: string[] = [];
      if (params.filePattern) {
        tips.push(
          'drop or widen filePattern (e.g. omit it to search every .cs and .xml file)',
        );
      }
      if (hasMeta) {
        tips.push(
          'escape regex metacharacters or simplify to a literal substring — search_source uses ripgrep regex syntax',
        );
      }
      tips.push(
        'for def-by-name lookup use search_defs, for a C# symbol (by short name or FQN) use read_symbol',
      );
      const tipsLine = `Tips: ${tips.join('; ')}.`;
      return {
        content: [
          {
            type: 'text',
            text:
              `No matches for /${params.query}/${flags}${filterNote} across the ${spec.corpusName}.\n${tipsLine}`,
          },
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
}

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
