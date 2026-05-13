import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import fsp from 'node:fs/promises';
import { detectRimWorldPaths } from '../paths.js';

const Params = Type.Object({
  lines: Type.Optional(
    Type.Number({
      description:
        'Maximum number of trailing lines to return after filtering. Default 200, max 2000.',
    }),
  ),
  pattern: Type.Optional(
    Type.String({
      description:
        "Case-insensitive substring to filter lines. If omitted, returns the raw tail. When the pattern is a [Ref XXXXXXXX] tag, the tool returns the ORIGINAL stack trace for that ref instead of the dedup-marker spam.",
    }),
  ),
});

export interface TailPlayerLogDetails {
  logPath: string | null;
  totalLines: number;
  matched: number;
  returned: number;
  /** True when output was contracted by run-length collapsing. */
  collapsed: boolean;
}

const REF_PATTERN_RE = /^\s*\[Ref ([0-9A-F]{8})\]\s*$/;
const DUPLICATE_MARKER_RE =
  /^\[Ref ([0-9A-F]{8})\] Duplicate stacktrace, see ref for original/;
const STACK_FRAME_RE = /^\s+at\s+\S+\(/;

/**
 * Collapse runs of `[Ref XXX] Duplicate stacktrace, see ref for original`
 * lines into a single `[Ref XXX] (×N duplicate stacktrace markers)` summary.
 *
 * RimWorld emits one of these markers per occurrence after the first; a hot
 * error loop fills the log (and our tool result) with thousands of identical
 * lines that carry no information beyond a count. The watcher already reports
 * counts in the auto-prompt; this just keeps the log-tail output from
 * blowing the context budget when the agent drills in.
 */
function collapseDuplicateMarkers(
  lines: string[],
): { lines: string[]; collapsed: boolean } {
  const out: string[] = [];
  let collapsed = false;
  let i = 0;
  while (i < lines.length) {
    const m = DUPLICATE_MARKER_RE.exec(lines[i]);
    if (!m) {
      out.push(lines[i]);
      i++;
      continue;
    }
    const ref = m[1];
    let run = 0;
    while (i < lines.length) {
      const m2 = DUPLICATE_MARKER_RE.exec(lines[i]);
      if (!m2 || m2[1] !== ref) break;
      run++;
      i++;
    }
    if (run === 1) {
      out.push(`[Ref ${ref}] Duplicate stacktrace, see ref for original`);
    } else {
      out.push(
        `[Ref ${ref}] (×${run} duplicate stacktrace markers — see [Ref ${ref}] for the original)`,
      );
      collapsed = true;
    }
  }
  return { lines: out, collapsed };
}

/**
 * If the caller asked about a specific [Ref XXX], find the FIRST occurrence
 * in the log (which is the one carrying the actual exception message + stack
 * frames — every later one is just a "Duplicate stacktrace" marker) and
 * return the surrounding block. This is what the agent wanted in 99% of
 * `tail_player_log(pattern="[Ref XXX]")` calls; the old behavior returned
 * 200 dedup markers and forced the agent to grep harder.
 *
 * Returns null when the pattern isn't a ref tag, when the ref isn't in the
 * log, or when the first occurrence has no stack trace attached (in which
 * case the regular tail/filter path is fine).
 */
function extractFirstStackForRef(
  allLines: string[],
  pattern: string,
): string[] | null {
  const refMatch = REF_PATTERN_RE.exec(pattern);
  if (!refMatch) return null;
  const refTag = `[Ref ${refMatch[1]}]`;
  const firstIdx = allLines.findIndex((l) => l.includes(refTag));
  if (firstIdx < 0) return null;
  if (DUPLICATE_MARKER_RE.test(allLines[firstIdx])) {
    // First occurrence is itself a dedup marker → no original in this log
    // (probably truncated). Fall back to the normal filter path.
    return null;
  }
  // Walk backward over the message/header lines that lead into the [Ref]
  // line. RimWorld writes:
  //   <error message line(s)>
  //   [Ref XXX]
  //     at Frame.A (...)
  //     at Frame.B (...)
  //
  // We grab up to 6 leading non-blank lines and all immediately-following
  // stack frames. 6 is enough for the longest "exception with inner cause"
  // headers without slurping unrelated info logs above.
  let start = firstIdx;
  for (let back = 0; back < 6 && start > 0; back++) {
    const prev = allLines[start - 1];
    if (prev.trim() === '') break;
    if (DUPLICATE_MARKER_RE.test(prev)) break;
    start--;
  }
  let end = firstIdx + 1;
  while (end < allLines.length) {
    const l = allLines[end];
    if (l.trim() === '') break;
    if (!STACK_FRAME_RE.test(l) && !/^\s/.test(l)) break;
    end++;
  }
  return allLines.slice(start, end);
}

export const tailPlayerLogTool: AgentTool<
  typeof Params,
  TailPlayerLogDetails
> = {
  name: 'tail_player_log',
  label: 'Tail Player.log',
  description:
    "Read trailing lines from RimWorld's Player.log to find runtime errors. Provide a pattern (e.g. an exception class or a mod name) to focus on the relevant lines. When the pattern is a [Ref XXXXXXXX] tag, returns the ORIGINAL stack trace for that ref (RimWorld writes one full trace per ref and N 'Duplicate stacktrace' markers for every later occurrence; the tool resolves to the original automatically). Without a ref pattern, runs of duplicate-stacktrace markers are collapsed to a single ×N count. Use for ad-hoc diagnostics; live monitoring during a test session is armed automatically by run_test_cycle and arrives as auto-prompt messages. Player.log is rewritten on each game launch, so call after the user has reproduced the issue.",
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<TailPlayerLogDetails>> {
    const { playerLog } = detectRimWorldPaths();
    if (!playerLog) {
      return {
        content: [
          {
            type: 'text',
            text: 'Player.log not found. Has RimWorld been launched at least once on this machine?',
          },
        ],
        details: {
          logPath: null,
          totalLines: 0,
          matched: 0,
          returned: 0,
          collapsed: false,
        },
      };
    }
    const max = Math.min(Math.max(params.lines ?? 200, 1), 2000);
    const fileText = await fsp.readFile(playerLog, 'utf8');
    const allLines = fileText.split(/\r?\n/);
    const pattern = params.pattern;

    // Ref-tag pattern → resolve to the first full-trace occurrence.
    const refStack = pattern ? extractFirstStackForRef(allLines, pattern) : null;
    if (refStack && pattern) {
      const text =
        `# ${playerLog}\n` +
        `# Showing original stack trace for ${pattern.trim()}; ` +
        `RimWorld emits one full trace then dedup markers for repeats.\n` +
        refStack.join('\n');
      return {
        content: [{ type: 'text', text }],
        details: {
          logPath: playerLog,
          totalLines: allLines.length,
          matched: refStack.length,
          returned: refStack.length,
          collapsed: false,
        },
      };
    }

    const filtered = pattern
      ? allLines.filter((l) =>
          l.toLowerCase().includes(pattern.toLowerCase()),
        )
      : allLines;
    const tail = filtered.slice(-max);
    const { lines: collapsedLines, collapsed } =
      collapseDuplicateMarkers(tail);
    const header =
      `# ${playerLog}\n# total=${allLines.length}, matched=${filtered.length}, ` +
      `returned=${collapsedLines.length}` +
      (collapsed
        ? ` (collapsed from ${tail.length} lines — duplicate-stacktrace markers run-length compressed)`
        : '') +
      (pattern ? `, pattern=${JSON.stringify(pattern)}` : '') +
      '\n';
    return {
      content: [{ type: 'text', text: header + collapsedLines.join('\n') }],
      details: {
        logPath: playerLog,
        totalLines: allLines.length,
        matched: filtered.length,
        returned: collapsedLines.length,
        collapsed,
      },
    };
  },
};
