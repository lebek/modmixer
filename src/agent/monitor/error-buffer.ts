// Batches incoming bridge error_event messages into a single auto-prompt
// for the agent. The bridge sends one event per Verse.Log.{Error,Warning,
// Message} call, already tagged with severity, attributed mods, and a stable
// stack-signature hash — so we don't have to guess severity from message
// shape, and the hash gives us perfect dedup of per-pawn/per-tick cascades.
//
// Edge-triggered, run-scoped. Each distinct error class is auto-prompted
// *once per run* (the first time it qualifies). Later recurrences of an
// already-reported class are silent — their count keeps accruing in the
// MonitorServer bucket, which the agent pulls on demand via monitor_poll.
// This is the deliberate fix for the old level-triggered behaviour, where a
// cascade that fired every N ticks re-prompted the agent every batch window
// for a bug it was already fixing. A "run" is one game session; the
// reported set is cleared when MonitorServer signals a new run.
//
// Batch lifecycle (collapses a burst of distinct new classes into one prompt):
//   - The first event in a batch arms quiet (3s) + hard (10s) timers.
//   - Each subsequent event resets the quiet timer.
//   - Hard timer caps latency under unbounded cascades.
//   - Flush emits a single summary listener call.
//
// Severity filtering happens at flush time, not ingest time, so a warning
// that fires N times during a batch still counts toward the count threshold
// even though no individual occurrence would qualify on its own.

import { EventEmitter } from 'node:events';
import type {
  BridgeMessage,
  ErrorEvent,
  ErrorSeverity,
} from './protocol.js';
import type { MonitorServer } from './server.js';

/** Fire after this much idle time with no new errors arriving. */
const QUIET_DEADLINE_MS = 3000;
/** Hard cap from the first error in a batch — bounds latency under cascades. */
const HARD_DEADLINE_MS = 10_000;
/** Trim displayed firstLine to this many chars (matches the old display cap). */
const MAX_DISPLAY_LEN = 240;

/**
 * Warning attribution needs at least this many occurrences in a batch to
 * surface when the mod-under-test isn't on the attribution. Tuned for
 * vanilla-warning cascades (e.g. "Humanlike pawn ... was added to
 * non-humanlike faction" firing once per generated pawn): a single
 * unrelated-mod warning is noise, a cascade is signal that something the
 * user's mod did is poking vanilla in a wrong way.
 */
const WARNING_COUNT_THRESHOLD = 3;

export interface ErrorBufferOptions {
  /**
   * Mod display name + packageId of the mod under test. Either match counts
   * as "attributed to my mod" for warning filtering. Pass both because
   * Attribution.ModsFromStack on the bridge side emits `mod.Name` first,
   * falling back to packageId — different mods land on different sides of
   * that fallback depending on their About.xml content.
   */
  modUnderTest?: { name: string; packageId: string };
}

/** One row in the surfaced summary. */
export interface ErrorBufferGroup {
  hash: string;
  severity: ErrorSeverity;
  firstLine: string;
  attributedMods: string[];
  count: number;
  firstAt: number;
  lastAt: number;
}

export type ErrorBufferListener = (
  groups: ErrorBufferGroup[],
  runId: number,
) => void;

export class ErrorBuffer {
  private pending = new Map<string, ErrorBufferGroup>();
  private quietTimer: NodeJS.Timeout | null = null;
  private hardTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<ErrorBufferListener>();
  private serverUnsubscribe: (() => void) | null = null;
  private opts: ErrorBufferOptions = {};
  /**
   * Hashes already surfaced in an auto-prompt for the current run. An
   * already-reported class is dropped on ingest — edge-triggered, so a
   * recurring error never re-prompts. Cleared on every new run.
   */
  private reported = new Set<string>();
  /** Run the buffer is currently accumulating for (see MonitorServer.getRunId). */
  private currentRunId = 0;

  /**
   * Hook the buffer up to a MonitorServer. Returns an unsubscribe handle
   * the caller can use to tear down (typically agent-host on conversation
   * switch / monitoring stop). The hookup uses `EventEmitter.on/off` because
   * MonitorServer is an EventEmitter and we want server semantics (multiple
   * subscribers, drop on close).
   */
  attach(server: MonitorServer, opts: ErrorBufferOptions = {}): () => void {
    this.opts = opts;
    // Seed from the server in case a game is already connected (the bridge
    // can be up before monitoring is armed) — without this the buffer would
    // report run #0 until the next relaunch.
    this.currentRunId = server.getRunId();
    const messageHandler = (msg: BridgeMessage) => {
      if (msg.type !== 'error_event') return;
      this.ingest(msg);
    };
    const runHandler = (runId: number) => this.onRun(runId);
    const emitter = server as unknown as EventEmitter;
    emitter.on('message', messageHandler);
    emitter.on('run', runHandler);
    this.serverUnsubscribe = () => {
      emitter.off('message', messageHandler);
      emitter.off('run', runHandler);
    };
    return () => this.detach();
  }

  detach(): void {
    this.serverUnsubscribe?.();
    this.serverUnsubscribe = null;
    this.cancelTimers();
    this.pending.clear();
  }

  /**
   * A new game session started. The previous run's pending batch and
   * reported set are meaningless now — drop them so the first error of the
   * new run prompts fresh.
   */
  private onRun(runId: number): void {
    this.currentRunId = runId;
    this.cancelTimers();
    this.pending.clear();
    this.reported.clear();
  }

  subscribe(listener: ErrorBufferListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Force an immediate flush regardless of timers. Used in tests and at
   * shutdown to drain pending events. No-op if nothing pending.
   */
  flushNow(): void {
    this.flush();
  }

  private ingest(msg: ErrorEvent): void {
    // Edge-triggered: a class already surfaced this run never re-prompts.
    // Its count keeps climbing in the MonitorServer bucket; the agent pulls
    // the updated total with monitor_poll when it wants it.
    if (this.reported.has(msg.hash)) return;
    const existing = this.pending.get(msg.hash);
    if (existing) {
      existing.count += 1;
      existing.lastAt = msg.at;
      existing.severity = msg.severity;
      existing.firstLine = msg.firstLine;
      existing.attributedMods = msg.attributedMods;
    } else {
      this.pending.set(msg.hash, {
        hash: msg.hash,
        severity: msg.severity,
        firstLine: msg.firstLine,
        attributedMods: msg.attributedMods.slice(),
        count: 1,
        firstAt: msg.at,
        lastAt: msg.at,
      });
    }
    this.armTimers();
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

    const candidates = Array.from(this.pending.values());
    this.pending.clear();

    const filtered = candidates.filter((g) => shouldSurface(g, this.opts));
    if (filtered.length === 0) return;

    // Mark surfaced classes reported so recurrences stay silent for the
    // rest of the run. Sub-threshold candidates that didn't surface are
    // intentionally NOT marked — they get another chance to cross the
    // count threshold in a later batch.
    for (const g of filtered) this.reported.add(g.hash);

    filtered.sort((a, b) => b.count - a.count || a.firstAt - b.firstAt);
    const runId = this.currentRunId;
    this.listeners.forEach((l) => l(filtered, runId));
  }
}

/**
 * Severity policy. Pulled out so tests can drive it directly without
 * standing up an ErrorBuffer instance + fake timers.
 */
export function shouldSurface(
  group: ErrorBufferGroup,
  opts: ErrorBufferOptions,
): boolean {
  if (group.severity === 'message') return false;
  if (group.severity === 'error') return true;
  // Warning. Surface if it's attributed to the mod under test, or if it
  // fires enough times in this batch to look like a real cascade.
  const mut = opts.modUnderTest;
  if (mut) {
    const attributedToUs = group.attributedMods.some(
      (a) =>
        a.toLowerCase() === mut.name.toLowerCase() ||
        a.toLowerCase() === mut.packageId.toLowerCase(),
    );
    if (attributedToUs) return true;
  }
  return group.count >= WARNING_COUNT_THRESHOLD;
}

/**
 * Render an error summary for the agent-facing prompt. Each row carries a
 * count, severity, attribution, hash tag, and first-line snippet — the
 * hash is what the agent passes to monitor_get_error(hash) to drill in for
 * full text + stack trace.
 *
 * Every row is a *new* error class for `runId` — the buffer is
 * edge-triggered, so classes already reported earlier in this run are not
 * repeated here. The `×count` is occurrences seen so far; it keeps climbing
 * silently after this prompt (pull the live total with monitor_poll).
 *
 * Plain newlines, no fence — the chat panel's user-message bubble renders
 * raw text (CSS pre-wrap) and a fence would show as literal backticks.
 *
 * Format-only: the triage protocol (severity rubric, attribution
 * interpretation, when to call monitor_get_error) lives in the system
 * prompt so we don't re-stamp it into chat on every event.
 */
export function formatErrorSummary(
  groups: ErrorBufferGroup[],
  runId: number,
): string {
  const classWord = groups.length === 1 ? 'class' : 'classes';

  const rows = groups.map((g) => {
    const count = `×${g.count}`;
    const sev = g.severity;
    const mods = `[${g.attributedMods.join(', ') || 'Unknown'}]`;
    const tag = `[#${g.hash}]`;
    const msg = truncateDisplay(g.firstLine);
    return `${count}  ${sev}  ${mods}  ${tag}  ${msg}`;
  });

  return [
    `[automated — test run #${runId}: ${groups.length} new error ${classWord}]`,
    '',
    ...rows,
  ].join('\n');
}

function truncateDisplay(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_DISPLAY_LEN) return flat;
  return flat.slice(0, MAX_DISPLAY_LEN - 1) + '…';
}
