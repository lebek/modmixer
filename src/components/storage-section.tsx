import { useEffect, useMemo, useState } from 'react';
import type {
  SnapshotCleanupProgressEvent,
  SnapshotUsageReport,
} from '../agent/snapshots';
import { formatBytes } from '../agent/index/format';
import { cn } from '@/lib/cn';
import { appConfirm } from './app-dialog';

/**
 * Settings → Storage. Shows what each mod's save history costs on disk and
 * runs the bulk cleanup: one decision over the whole batch instead of a
 * dialog per mod. The policy is uniform and conservative — manual/named
 * saves and the newest autosaves always survive — which is what makes a
 * default-all selection legitimate.
 */
export function StorageSection() {
  const [report, setReport] = useState<SnapshotUsageReport | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<
    Map<string, SnapshotCleanupProgressEvent>
  >(new Map());
  const [freedTotal, setFreedTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const next = await window.modmixer.getSnapshotUsage();
    setReport(next);
    setSelected(new Set(next.rows.map((row) => row.folder)));
  };

  useEffect(() => {
    refresh().catch((err) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, []);

  useEffect(
    () =>
      window.modmixer.onSnapshotCleanupProgress((event) => {
        setProgress((prev) => new Map(prev).set(event.folder, event));
      }),
    [],
  );

  const selectedRows = useMemo(
    () => (report?.rows ?? []).filter((row) => selected.has(row.folder)),
    [report, selected],
  );
  const trimmableSelected = selectedRows.reduce(
    (sum, row) => sum + row.trimmableCount,
    0,
  );
  const orphansSelected = selectedRows.filter((row) => row.orphaned).length;

  const toggle = (folder: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };

  const runCleanup = async () => {
    if (!report || selectedRows.length === 0) return;
    const modCount = selectedRows.length;
    const orphanNote =
      orphansSelected > 0
        ? ` Histories for ${orphansSelected} deleted mod${
            orphansSelected === 1 ? '' : 's'
          } are removed entirely.`
        : '';
    const ok = await appConfirm(
      `Manual and named saves are always kept, along with the ${report.keepAutosaves} most recent autosaves of each mod. Older autosaves are removed permanently.${orphanNote}`,
      {
        title: `Clean up history for ${modCount} mod${modCount === 1 ? '' : 's'}?`,
        okLabel: 'Clean up',
        tone: 'danger',
      },
    );
    if (!ok) return;
    setError(null);
    setFreedTotal(null);
    setProgress(new Map());
    setRunning(true);
    try {
      const summary = await window.modmixer.cleanupSnapshots(
        report.rows
          .filter((row) => selected.has(row.folder))
          .map((row) => row.folder),
      );
      setFreedTotal(summary.freedBytes);
      if (summary.failures > 0) {
        setError(
          `${summary.failures} mod${summary.failures === 1 ? '' : 's'} could not be cleaned up — see rows below.`,
        );
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  if (!report) {
    return <p className="text-sm text-muted">{error ?? 'Measuring…'}</p>;
  }

  return (
    <div className="space-y-4">
      <div>
        <div className="text-sm text-ink">Save history</div>
        <p className="mt-0.5 text-xs text-muted">
          The agent saves a checkpoint of your mod after every reply so you
          can roll back. Old checkpoints add up — cleaning up keeps every
          manual and named save plus the {report.keepAutosaves} most recent
          autosaves of each mod, and frees the space held by the rest.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-failed/40 bg-failed/5 px-3 py-2 text-xs text-failed">
          {error}
        </div>
      )}
      {freedTotal !== null && !error && (
        <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs text-ink">
          Freed {formatBytes(freedTotal)}.
        </div>
      )}

      {report.rows.length === 0 ? (
        <p className="text-sm text-subtle">No save history on disk yet.</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {report.rows.map((row) => {
            const p = progress.get(row.folder);
            return (
              <li
                key={row.folder}
                className="flex items-center gap-3 px-3 py-2"
              >
                <input
                  type="checkbox"
                  checked={selected.has(row.folder)}
                  disabled={running}
                  onChange={() => toggle(row.folder)}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] text-ink">
                    {row.name}
                    {row.orphaned && (
                      <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
                        deleted mod
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
                    {row.orphaned
                      ? 'history only — cleanup removes it entirely'
                      : `${row.saveCount} save${row.saveCount === 1 ? '' : 's'}` +
                        (row.trimmableCount > 0
                          ? ` · ${row.trimmableCount} trimmable`
                          : '')}
                  </div>
                </div>
                {p && (
                  <span
                    className={cn(
                      'font-mono text-[10px] uppercase tracking-[0.18em]',
                      p.status === 'error' ? 'text-failed' : 'text-muted',
                    )}
                  >
                    {p.status === 'working'
                      ? 'cleaning…'
                      : p.status === 'done'
                        ? `freed ${formatBytes(p.freedBytes ?? 0)}`
                        : (p.error ?? 'failed')}
                  </span>
                )}
                <span className="w-20 text-right font-mono text-[11px] text-ink">
                  {formatBytes(row.bytes)}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-line pt-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          Total {formatBytes(report.totalBytes)}
        </span>
        <button
          type="button"
          disabled={running || selectedRows.length === 0}
          onClick={() => void runCleanup()}
          className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft disabled:opacity-50"
        >
          {running
            ? 'Cleaning up…'
            : `Clean up ${selectedRows.length} mod${selectedRows.length === 1 ? '' : 's'}`}
        </button>
      </div>
      {trimmableSelected > 0 && !running && (
        <p className="text-right text-xs text-subtle">
          Would trim {trimmableSelected} old autosave
          {trimmableSelected === 1 ? '' : 's'} across the selected mods.
        </p>
      )}
    </div>
  );
}
