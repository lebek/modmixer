/**
 * Progress events emitted by the index rebuilder. Forwarded over IPC (tagged
 * by game on the game-setup channel) to the renderer's GameSetupGate +
 * onboarding index step. Phases run in order; "starting" fires once before any
 * phase, "done" once at the end (or "error" if anything threw).
 */
export type IndexPhase = 'defs' | 'decompile' | 'symbols';

export type IndexProgressEvent =
  | { type: 'starting'; phases: IndexPhase[] }
  | {
      type: 'phase';
      phase: IndexPhase;
      /** Human-readable subtitle, e.g. "Decompiling Royalty.dll". */
      message: string;
      /** Optional 0..1 fraction. Indeterminate phases omit this. */
      fraction?: number;
    }
  | { type: 'done'; durationMs: number }
  | { type: 'error'; message: string };

export type IndexProgressListener = (e: IndexProgressEvent) => void;
