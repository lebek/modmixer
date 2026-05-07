import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { detectRimWorldPaths } from './paths.js';

/**
 * One distinct error class detected in Player.log, with an occurrence count.
 *
 * Errors are grouped by RimWorld's own `[Ref XXXXXXXX]` tag where present —
 * `Verse.Log.Error` stamps every emission with an 8-hex ref derived from the
 * stack trace, so the same call site collapses to a single group regardless
 * of how many times it fires (RimWorld even emits "Duplicate stacktrace,
 * see ref for original" for recurrences). For ref-less errors (def-loader
 * "Config error in X", XML parse failures, asset-load failures), we group
 * by a normalized version of the first line.
 */
export interface LogErrorGroup {
  /** Internal grouping key. Stable across repeated occurrences. */
  key: string;
  /** Display tag — `[Ref AA2B8458]` or `[no-ref]`. */
  refLabel: string;
  /** Substring the agent can pass to `tail_player_log(pattern=...)` to drill in. */
  drillPattern: string;
  /** Representative message (first occurrence's text, single-lined and capped). */
  message: string;
  count: number;
  firstAt: number;
  lastAt: number;
  /** True if at least one occurrence in this group came with a stack trace. */
  hasStackTrace: boolean;
}

export type LogErrorListener = (groups: LogErrorGroup[]) => void;

const POLL_INTERVAL_MS = 1000;
/** Fire after this much idle time with no new errors arriving. */
const QUIET_DEADLINE_MS = 3000;
/** Hard cap from the first error in a batch — bounds latency under cascades. */
const HARD_DEADLINE_MS = 10_000;
const MAX_DISPLAY_LEN = 240;

const REF_RE = /\[Ref ([0-9A-F]{8})\]/;
/** Mono/IL2CPP managed stack frame. Reliable across Unity versions. */
const STACK_FRAME_RE = /^\s+at \S+\s*\(/;
/**
 * Headers for error blocks that emit no `[Ref]` and no stack trace —
 * primarily def-loader and XML-parse paths. Anchored to start-of-line.
 */
const NO_REF_HEADERS = [
  /^Config error in /,
  /^XML error[: ]/,
  /^Could not load (?:texture|AudioClip|asset)/,
  /^Could not resolve cross-reference/,
  /^Could not find a type named/,
  /^Could not load reference to/,
];
const NOISE_PATTERNS = [
  /^Fallback handler could not load library/,
  /^Could not load library/,
  /\[PhysX\]/,
];

export class LogWatcher {
  private position = 0;
  private inode: number | null = null;
  private logPath: string | null = null;
  private listeners = new Set<LogErrorListener>();
  private watchHandler: ((curr: fs.Stats, prev: fs.Stats) => void) | null =
    null;

  // Pending batch state — accumulated across poll cycles, flushed on deadline.
  private pending = new Map<string, LogErrorGroup>();
  private quietTimer: NodeJS.Timeout | null = null;
  private hardTimer: NodeJS.Timeout | null = null;

  start(): void {
    const { playerLog } = detectRimWorldPaths();
    if (!playerLog) return;
    this.logPath = playerLog;
    this.snapshotEnd();
    // fs.watchFile polls the PATH (not the inode), so it survives RimWorld
    // rotating Player.log on each launch (rename to Player-prev.log + create
    // a fresh Player.log). fs.watch on a file follows the inode and silently
    // misses post-rotation writes.
    this.watchHandler = () => void this.readNew();
    fs.watchFile(this.logPath, { interval: POLL_INTERVAL_MS }, this.watchHandler);
  }

  /**
   * Set position to the current end of the file. Use right before triggering
   * a new RimWorld launch — combined with inode tracking, this skips any
   * pre-existing log content but captures everything written from this run on.
   */
  resetForNewSession(): void {
    this.snapshotEnd();
    this.pending.clear();
    this.cancelTimers();
  }

  /**
   * Read the entire current Player.log immediately and emit any errors found.
   * Bypasses the batch deadline — used when the watcher missed events (first
   * ModMixer launch after errors already happened, or to manually retrigger
   * a scan).
   */
  async scanNow(): Promise<LogErrorGroup[]> {
    if (!this.logPath) return [];
    try {
      const stat = await fsp.stat(this.logPath);
      const buf = await fsp.readFile(this.logPath);
      this.position = stat.size;
      this.inode = stat.ino;
      const groups = mergeGroups(parseErrorBlocks(buf.toString('utf8')));
      if (groups.length > 0) {
        this.listeners.forEach((l) => l(groups));
      }
      return groups;
    } catch {
      return [];
    }
  }

  subscribe(listener: LogErrorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    if (this.logPath && this.watchHandler) {
      fs.unwatchFile(this.logPath, this.watchHandler);
      this.watchHandler = null;
    }
    this.cancelTimers();
    this.pending.clear();
  }

  private snapshotEnd(): void {
    if (!this.logPath) return;
    try {
      const stat = fs.statSync(this.logPath);
      this.position = stat.size;
      this.inode = stat.ino;
    } catch {
      this.position = 0;
      this.inode = null;
    }
  }

  private async readNew(): Promise<void> {
    if (!this.logPath) return;
    try {
      const stat = await fsp.stat(this.logPath);
      const rotated = this.inode !== null && stat.ino !== this.inode;
      if (rotated || stat.size < this.position) {
        // New file (rotation) or truncation — start from the beginning of
        // the current file so we capture this session's full output.
        this.position = 0;
        this.inode = stat.ino;
      }
      if (stat.size === this.position) return;

      const fd = await fsp.open(this.logPath, 'r');
      try {
        const buf = Buffer.alloc(stat.size - this.position);
        await fd.read(buf, 0, buf.length, this.position);
        this.position = stat.size;
        this.inode = stat.ino;
        const blocks = parseErrorBlocks(buf.toString('utf8'));
        for (const g of blocks) {
          this.mergePending(g);
        }
        if (this.pending.size > 0) {
          this.armTimers();
        }
      } finally {
        await fd.close();
      }
    } catch {
      // Transient — next poll retries.
    }
  }

  private mergePending(g: LogErrorGroup): void {
    const existing = this.pending.get(g.key);
    if (existing) {
      existing.count += g.count;
      existing.lastAt = g.lastAt;
      existing.hasStackTrace = existing.hasStackTrace || g.hasStackTrace;
    } else {
      this.pending.set(g.key, { ...g });
    }
  }

  private armTimers(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.flush(), QUIET_DEADLINE_MS);
    if (!this.hardTimer) {
      this.hardTimer = setTimeout(() => this.flush(), HARD_DEADLINE_MS);
    }
  }

  private cancelTimers(): void {
    if (this.quietTimer) {
      clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
    if (this.hardTimer) {
      clearTimeout(this.hardTimer);
      this.hardTimer = null;
    }
  }

  private flush(): void {
    this.cancelTimers();
    if (this.pending.size === 0) return;
    // Sort: high-count first (cascade signal), then earliest-seen first.
    const groups = Array.from(this.pending.values()).sort((a, b) =>
      b.count - a.count || a.firstAt - b.firstAt,
    );
    this.pending.clear();
    this.listeners.forEach((l) => l(groups));
  }
}

let instance: LogWatcher | null = null;

/** Process-wide singleton. The first call starts the watcher. */
export function getLogWatcher(): LogWatcher {
  if (!instance) {
    instance = new LogWatcher();
    instance.start();
  }
  return instance;
}

/**
 * Render a deduped error summary for the agent-facing prompt. Each row is
 * one error class with an occurrence count and a [Ref XXX] / [no-ref] tag.
 *
 * Plain newlines, no fence — the chat panel's user-message bubble renders
 * raw text (not markdown) and relies on CSS `whitespace: pre-wrap` to keep
 * line breaks. A fence would show as literal backticks.
 *
 * Format-only — the protocol for interpreting the summary (drill-in via
 * `tail_player_log`, monitoring continuation, the four triage categories)
 * lives in the system prompt so it isn't re-stamped into chat on every event.
 */
export function formatErrorSummary(groups: LogErrorGroup[]): string {
  const total = groups.reduce((acc, g) => acc + g.count, 0);
  const errorWord = total === 1 ? 'error' : 'errors';
  const uniqueClause =
    groups.length === total ? '' : ` (${groups.length} unique)`;
  // Pad ×counts so the ref/message columns line up across rows. The user
  // bubble uses a proportional font, so column alignment is approximate —
  // the padding is mostly there to visually group "count, ref, message".
  const countWidth = Math.max(
    ...groups.map((g) => `×${g.count}`.length),
    2,
  );
  const refWidth = Math.max(...groups.map((g) => g.refLabel.length), 9);
  const rows = groups.map((g) => {
    const c = `×${g.count}`.padStart(countWidth);
    const ref = g.refLabel.padEnd(refWidth);
    return `${c}  ${ref}  ${g.message}`;
  });
  return [
    `[automated — RimWorld emitted ${total} ${errorWord}${uniqueClause} during your test session]`,
    '',
    ...rows,
  ].join('\n');
}

/**
 * Parse the buffer into per-block error candidates via a line-by-line state
 * machine. Each call to this function processes a contiguous chunk of new
 * bytes, so multiple occurrences of the same `[Ref]` produce multiple
 * `LogErrorGroup` entries with `count: 1` — the watcher merges them via
 * `mergePending`.
 *
 * Why a state machine instead of block-splitting on blank lines: in real
 * RimWorld Player.log output the cascade entries (1000+ "Error while
 * determining if Zombie<N> should have Need <X>" style errors) are
 * separated only by single newlines, NOT blank lines. A naive
 * `split(/\n\s*\n/)` collapses the entire cascade into one block and only
 * the first `[Ref]` survives.
 *
 * The state machine instead walks lines and recognizes:
 *   - `^\s+at \S+\(` → stack frame (consumed silently as part of a trace)
 *   - `[Ref XXXXXXXX]` → ends an error block; lines accumulated since the
 *     last frame/blank are the error message
 *   - blank line → resets the header buffer (with no-ref flush attempt)
 *   - any other column-0 line → header / continuation candidate
 *
 * Exported for tests; not part of the watcher's public API.
 */
export function parseErrorBlocks(text: string): LogErrorGroup[] {
  const out: LogErrorGroup[] = [];
  const now = Date.now();
  /**
   * `idle`       — between blocks, buffer empty.
   * `collecting` — accumulating column-0 lines as a possible header.
   * `in_trace`   — inside a stack-trace block (after [Ref] or after a
   *                no-ref Unity exception emission). Frames are silently
   *                consumed; the next column-0 line starts a new header.
   */
  type Mode = 'idle' | 'collecting' | 'in_trace';
  let mode: Mode = 'idle';
  let buffer: string[] = [];
  /** Index in `out` of the most recent emission, for late hasStackTrace updates. */
  let lastIdx = -1;

  const flushNoRefHeader = () => {
    if (buffer.length === 0) return;
    // Walk the buffer line-by-line — each NO_REF_HEADERS-matching line is
    // its own event (e.g. two consecutive `Config error in X` /
    // `Config error in Y` lines should yield two groups, not one).
    // Non-matching lines (info logs that landed between errors) are
    // silently dropped here.
    for (const line of buffer) {
      if (NOISE_PATTERNS.some((p) => p.test(line))) continue;
      if (!NO_REF_HEADERS.some((p) => p.test(line))) continue;
      const message = displayMessage(line);
      out.push({
        key: `msg:${normalizeMessage(message)}`,
        refLabel: '[no-ref]',
        drillPattern: drillPattern(message),
        message,
        count: 1,
        firstAt: now,
        lastAt: now,
        hasStackTrace: false,
      });
      lastIdx = out.length - 1;
    }
    buffer = [];
  };

  /** Take only the last few col-0 lines as the error message — bounds buffer
   * growth and avoids slurping unrelated preceding info logs into a [Ref]
   * emission. Two lines comfortably covers `<message>` + `Parameter name: …`. */
  const messageFromBuffer = (): string => {
    if (buffer.length === 0) return '';
    const tail = buffer.slice(-2);
    return displayMessage(tail.join('\n'));
  };

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === '') {
      if (mode === 'collecting') flushNoRefHeader();
      mode = 'idle';
      buffer = [];
      continue;
    }

    // Indented non-frame lines — typically Mono trace cruft (orphan
    // `[0x0000c] in <hash>:0` lines that immediately follow [Ref], "--- End
    // of inner exception ---" markers, dynamic-method wrapper lines).
    // Treat them as part of the current trace; don't let them masquerade
    // as no-ref headers. Checked BEFORE STACK_FRAME_RE just so the no-frame
    // branch below can stay intentionally narrow.
    if (/^[ \t]/.test(line) && !STACK_FRAME_RE.test(line)) {
      if (mode === 'in_trace' && lastIdx >= 0) {
        out[lastIdx].hasStackTrace = true;
      }
      continue;
    }

    if (STACK_FRAME_RE.test(line)) {
      if (mode === 'collecting' && buffer.length > 0) {
        // Frame after a header that hadn't seen [Ref] yet — Unity exception
        // path that bypasses Verse.Log's [Ref] tagging. Emit as no-ref.
        const block = buffer.join('\n');
        if (!NOISE_PATTERNS.some((p) => p.test(block))) {
          const message = displayMessage(buffer[0]);
          out.push({
            key: `msg:${normalizeMessage(message)}`,
            refLabel: '[no-ref]',
            drillPattern: drillPattern(message),
            message,
            count: 1,
            firstAt: now,
            lastAt: now,
            hasStackTrace: true,
          });
          lastIdx = out.length - 1;
        }
        buffer = [];
      } else if (mode === 'in_trace' && lastIdx >= 0) {
        out[lastIdx].hasStackTrace = true;
      }
      mode = 'in_trace';
      continue;
    }

    const refMatch = REF_RE.exec(line);
    if (refMatch) {
      const ref = refMatch[1];
      const message = messageFromBuffer() || displayMessage(line);
      out.push({
        key: `ref:${ref}`,
        refLabel: `[Ref ${ref}]`,
        drillPattern: `[Ref ${ref}]`,
        message,
        count: 1,
        firstAt: now,
        lastAt: now,
        hasStackTrace: false,
      });
      lastIdx = out.length - 1;
      buffer = [];
      mode = 'in_trace';
      continue;
    }

    // Column-0 non-frame, non-ref, non-blank line.
    if (mode === 'in_trace') {
      // The trace ended; this line is a new error header.
      mode = 'collecting';
      buffer = [line];
    } else if (mode === 'collecting') {
      buffer.push(line);
    } else {
      mode = 'collecting';
      buffer = [line];
    }
  }
  if (mode === 'collecting') flushNoRefHeader();
  return out;
}

/**
 * Combine per-block parses into one group per key. Used by `scanNow` and by
 * tests; the live watcher accumulates incrementally via `mergePending`.
 */
export function mergeGroups(blocks: LogErrorGroup[]): LogErrorGroup[] {
  const map = new Map<string, LogErrorGroup>();
  for (const g of blocks) {
    const existing = map.get(g.key);
    if (existing) {
      existing.count += g.count;
      existing.lastAt = g.lastAt;
      existing.hasStackTrace = existing.hasStackTrace || g.hasStackTrace;
    } else {
      map.set(g.key, { ...g });
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => b.count - a.count || a.firstAt - b.firstAt,
  );
}

function displayMessage(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_DISPLAY_LEN) return flat;
  return flat.slice(0, MAX_DISPLAY_LEN - 1) + '…';
}

/**
 * Collapse identifying numbers/hex IDs so per-instance variants of the same
 * error fold into a single group key. e.g. `Zombie21664` and `Zombie53127`
 * both normalize to `Zombie<N>`. Only used for ref-less grouping; refs are
 * already a perfect key.
 *
 * No `\b` here on purpose — JS word boundaries treat `_` and letters both
 * as word chars, so `Zombie21664` has no boundary between the letter and
 * digit. We just match runs of 2+ digits anywhere; collateral hits on
 * versions / sizes are harmless because grouping is a key match across
 * the whole message, not a per-token decision.
 */
function normalizeMessage(msg: string): string {
  return msg
    .replace(/\d{2,}/g, '<N>')
    .replace(/0x[0-9a-fA-F]+/gi, '<H>');
}

/**
 * A short, distinctive substring the agent can hand to `tail_player_log`'s
 * pattern arg. Prefer the part before the first colon (typically the error
 * "header"), capped to keep the suggestion compact.
 */
function drillPattern(message: string): string {
  const colon = message.indexOf(':');
  const head = colon > 0 ? message.slice(0, colon) : message;
  return head.trim().slice(0, 80);
}
