import { useState } from 'react';
import { cn } from '@/lib/cn';
import type { MonitorStream } from './use-monitor-stream';
import { Panel } from './perf-panel';

export function ErrorsPanel({ stream }: { stream: MonitorStream }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'error' | 'warning'>('all');

  const errors = stream.errors.filter((e) =>
    filter === 'all' ? true : e.severity === filter,
  );

  return (
    <Panel
      title="errors & warnings"
      subtitle={`${stream.errors.length} unique · ${stream.errorsTotal} total`}
      rightSlot={
        <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.18em]">
          {(['all', 'error', 'warning'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded px-1.5 py-0.5 transition-colors',
                filter === f
                  ? 'bg-ink text-paper'
                  : 'text-subtle hover:text-ink',
              )}
            >
              {f}
            </button>
          ))}
        </div>
      }
    >
      {errors.length === 0 ? (
        <div className="px-2 py-6 text-center font-mono text-[11px] text-subtle">
          {stream.errorsTotal === 0
            ? 'No errors detected. Stay vigilant.'
            : 'No matches for filter.'}
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-line/40">
          {errors.map((e) => {
            const isOpen = expanded === e.hash;
            return (
              <div key={e.hash} className="py-1.5 font-mono text-[11px]">
                <button
                  onClick={() => setExpanded(isOpen ? null : e.hash)}
                  className="flex w-full items-start gap-2 text-left"
                >
                  <span className="w-14 shrink-0 text-subtle tabular-nums">
                    {formatTime(e.lastAt)}
                  </span>
                  <span
                    className={cn(
                      'w-16 shrink-0 text-[10px] uppercase tracking-[0.18em]',
                      severityColor(e.severity),
                    )}
                  >
                    {e.severity}
                  </span>
                  {e.count > 1 && (
                    <span className="w-10 shrink-0 rounded bg-raised text-center text-[10px] uppercase tracking-[0.18em] text-muted">
                      ×{e.count}
                    </span>
                  )}
                  <span className="flex-1 truncate text-ink">{e.firstLine}</span>
                  <span className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-subtle">
                    {e.attributedMods.length === 0
                      ? '—'
                      : e.attributedMods.slice(0, 2).join(', ')}
                    {e.attributedMods.length > 2 &&
                      ` +${e.attributedMods.length - 2}`}
                  </span>
                </button>
                {isOpen && (
                  <pre className="mt-1.5 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-paper px-2 py-2 text-[10px] leading-relaxed text-muted">
                    {e.text}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

function severityColor(s: 'message' | 'warning' | 'error'): string {
  if (s === 'error') return 'text-failed';
  if (s === 'warning') return 'text-accent';
  return 'text-subtle';
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
