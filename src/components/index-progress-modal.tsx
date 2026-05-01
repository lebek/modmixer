import { useEffect, useState } from 'react';
import type { IndexProgressEvent, IndexPhase } from '@/agent/index/progress';
import type { IndexSnapshot } from '@/agent/index/main-bridge';

const PHASE_LABEL: Record<IndexPhase, string> = {
  defs: 'Indexing defs',
  decompile: 'Decompiling RimWorld assemblies',
  symbols: 'Indexing C# symbols',
};

/**
 * Surfaces the index rebuild that runs at app startup (or when the user
 * clicks "Rebuild" in Settings). The modal blocks the main UI on first
 * launch — without an index, search_defs / search_source return a "not
 * built yet" stub and the agent can't do meaningful lookup.
 *
 * Renders nothing when there's nothing happening (status fresh + not
 * rebuilding) so we don't flicker on every re-render.
 */
export function IndexProgressModal() {
  const [snapshot, setSnapshot] = useState<IndexSnapshot | null>(null);
  const [latest, setLatest] = useState<IndexProgressEvent | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.modmixer.getIndexSnapshot().then((s) => {
      if (cancelled) return;
      setSnapshot(s);
      if (s.lastProgress) setLatest(s.lastProgress);
    });
    const unsub = window.modmixer.onIndexProgress((evt) => {
      setLatest(evt);
      // Refresh the snapshot when the rebuild settles so the meta sidebar
      // reflects the new index size etc.
      if (evt.type === 'done' || evt.type === 'error') {
        void window.modmixer.getIndexSnapshot().then(setSnapshot);
      } else {
        void window.modmixer.getIndexSnapshot().then(setSnapshot);
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  if (!snapshot) return null;
  // Hide the modal if we're idle and the index is fresh.
  const idle = !snapshot.rebuilding;
  const lastDone = latest?.type === 'done' || latest?.type === 'error';
  if (idle && (snapshot.status.type === 'fresh' || snapshot.status.type === 'no-rimworld') && lastDone) {
    return null;
  }
  if (idle && snapshot.status.type === 'fresh') return null;
  if (idle && snapshot.status.type === 'no-rimworld') return null;

  // What to show as the title + subtitle.
  let title = 'Building RimWorld index';
  let subtitle: string | null = null;
  let phaseFraction: number | null = null;
  let isError = false;
  let isDone = false;

  if (latest?.type === 'phase') {
    title = PHASE_LABEL[latest.phase] ?? 'Building RimWorld index';
    subtitle = latest.message;
    if (typeof latest.fraction === 'number') phaseFraction = latest.fraction;
  } else if (latest?.type === 'starting') {
    subtitle = `Phases: ${latest.phases.map((p) => PHASE_LABEL[p]).join(' → ')}`;
  } else if (latest?.type === 'done') {
    title = 'Index ready';
    subtitle = `Built in ${(latest.durationMs / 1000).toFixed(1)}s.`;
    isDone = true;
  } else if (latest?.type === 'error') {
    title = 'Index build failed';
    subtitle = latest.message;
    isError = true;
  } else if (snapshot.status.type === 'absent') {
    title = 'Building RimWorld index';
    subtitle = 'First-run setup — this takes a minute. Subsequent launches are instant.';
  } else if (snapshot.status.type === 'stale') {
    title = 'Updating RimWorld index';
    subtitle = `Reason: ${snapshot.status.reason}.`;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-6">
      <div className="w-full max-w-md rounded-md border border-line bg-paper p-5 shadow-lg">
        <h2 className="font-display text-base font-medium text-ink">{title}</h2>
        {subtitle && (
          <p className="mt-2 text-sm text-muted">{subtitle}</p>
        )}
        {!isDone && !isError && (
          <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-surface">
            <div
              className="h-full bg-accent transition-all"
              style={{
                width:
                  phaseFraction !== null
                    ? `${Math.max(2, phaseFraction * 100)}%`
                    : '40%',
                animation:
                  phaseFraction === null
                    ? 'indexIndeterminate 1.4s linear infinite'
                    : undefined,
              }}
            />
          </div>
        )}
        {(isDone || isError) && (
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() =>
                void window.modmixer.getIndexSnapshot().then(setSnapshot)
              }
              className="rounded-md border border-line px-3 py-1.5 font-mono text-xs text-ink hover:bg-surface"
            >
              {isError ? 'Dismiss' : 'OK'}
            </button>
          </div>
        )}
        {!isDone && !isError && snapshot.rebuilding && (
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => {
                void window.modmixer.cancelIndexRebuild();
              }}
              className="rounded-md border border-line px-3 py-1.5 font-mono text-xs text-muted hover:text-ink"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
