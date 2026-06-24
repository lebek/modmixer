import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { getIndexPaths } from '../index/paths.js';
import { getIndexStatus } from '../index/rebuild.js';
import { ensureMinecraftIndexInBackground } from '../index/rebuild-minecraft.js';
import { resolveRipgrep } from '../index/ripgrep.js';
import type { GameId } from '../games/types.js';

// Built per-game so the param docs name the corpus actually being searched:
// RimWorld decompiled C# + Defs XML vs Minecraft mojmap+Parchment Java sources.
// Identical shape, so `typeof Params` remains a stable type anchor.
function searchSourceParams(game: GameId) {
  const isMc = game === 'minecraft';
  return Type.Object({
    query: Type.String({
      description: isMc
        ? 'Regex pattern (ripgrep syntax) to search across the decompiled Minecraft + NeoForge Java source (mojmap + Parchment names). Anchor with `\\b` for whole-word matches.'
        : 'Regex pattern (ripgrep syntax) to search for in the decompiled RimWorld C# source AND the indexed Defs XML. Anchor with `\\b` for whole-word matches.',
    }),
    caseSensitive: Type.Optional(
      Type.Boolean({ description: 'Match case (default false).' }),
    ),
    filePattern: Type.Optional(
      Type.String({
        description: isMc
          ? 'Glob to restrict matches (e.g. "**/world/item/*.java" for one package, or "**/*.java"). Default: every indexed Java source file.'
          : 'Glob to restrict matches (e.g. "**/Verse/AI/*.cs" for C# only, "**/*.xml" for Defs only, "**/Designations/*.xml" for a single Defs subdir). Default: every file under both the C# source corpus and the Defs XML corpus.',
      }),
    ),
    maxLines: Type.Optional(
      Type.Number({
        description: 'Hard cap on total result lines (default 200, max 800).',
      }),
    ),
  });
}

const Params = searchSourceParams('rimworld');

const NO_INDEX_MSG =
  'RimWorld source index is not built yet (or built without C# decompile). Open Settings → RimWorld index → Rebuild.';

const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Resolve the index status for a game and a user-facing "not ready" message.
 * For Minecraft the index builds lazily on first use (no Settings UI yet), so
 * an absent index is kicked off in the background here.
 */
function indexNotReady(game: GameId): string | null {
  if (game === 'minecraft') {
    const status = ensureMinecraftIndexInBackground();
    if (status === 'fresh') return null;
    if (status === 'building')
      return 'The Minecraft code index is still building (one-time decompile, a few minutes). Try again shortly — do other work meanwhile.';
    return 'The Minecraft code index isn\'t built yet — I just started it in the background (one-time decompile, a few minutes). Try again shortly.';
  }
  const status = getIndexStatus();
  if (status.type === 'absent' || status.type === 'no-rimworld') return NO_INDEX_MSG;
  return null;
}

export function createSearchSourceTool(
  game: GameId = 'rimworld',
): AgentTool<typeof Params, { matchedLines: number; truncated: boolean }> {
  const isMc = game === 'minecraft';
  return {
  name: 'search_source',
  label: isMc ? 'Search Minecraft source' : 'Search RimWorld source',
  description: isMc
    ? 'Ripgrep over the decompiled Minecraft + NeoForge Java source (mojmap + Parchment names). Use for finding call sites, event/registry usage, vanilla behaviour, or any pattern that isn\'t a clean type/method name. For symbol-level lookup (a Java class/method by name) prefer read_symbol.'
    : 'Ripgrep over the decompiled RimWorld C# source AND the indexed Defs XML. Use for finding call sites ("StealAIUtility\\\\b"), patch targets, def cross-references like `<li>Designator_AreaHomeExpand</li>`, attribute values, or any pattern that isn\'t a clean type/method name. For symbol-level C# lookup (by short name or FQN) prefer read_symbol; for def-by-name lookup prefer search_defs. Zero matches here often means the answer lives in an XML def — try search_defs as the fallback.',
  parameters: searchSourceParams(game),
  async execute(_id, params, signal): Promise<AgentToolResult<{ matchedLines: number; truncated: boolean }>> {
    const notReady = indexNotReady(game);
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
              `No matches for /${params.query}/${flags}${filterNote} across the ${isMc ? 'Minecraft + NeoForge Java source' : 'RimWorld C# source and Defs XML index'}.\n${tipsLine}`,
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
