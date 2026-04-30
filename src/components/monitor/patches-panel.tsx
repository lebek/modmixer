import { useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import type { MonitorStream } from './use-monitor-stream';
import { Panel } from './perf-panel';

export function PatchesPanel({
  stream,
  selectedMod,
}: {
  stream: MonitorStream;
  selectedMod: string | null;
}) {
  const [filter, setFilter] = useState('');

  const conflicts = stream.snapshot?.conflicts ?? [];
  const allPatches = stream.snapshot?.patches ?? [];

  const patches = useMemo(() => {
    let list = allPatches;
    if (selectedMod) {
      const modName = stream.snapshot?.mods.find(
        (m) => m.packageId === selectedMod,
      )?.name;
      if (modName) {
        list = list.filter((p) =>
          [...p.prefixes, ...p.postfixes, ...p.transpilers, ...p.finalizers]
            .includes(modName),
        );
      }
    }
    if (filter.trim()) {
      const f = filter.toLowerCase();
      list = list.filter((p) => p.method.toLowerCase().includes(f));
    }
    // sort: destructive first, then by mod count
    return list.slice().sort((a, b) => {
      const ad = a.destructiveBy.length;
      const bd = b.destructiveBy.length;
      if (ad !== bd) return bd - ad;
      const am =
        a.prefixes.length + a.postfixes.length + a.transpilers.length;
      const bm =
        b.prefixes.length + b.postfixes.length + b.transpilers.length;
      return bm - am;
    });
  }, [allPatches, selectedMod, stream.snapshot, filter]);

  return (
    <Panel
      title="patch graph"
      subtitle={
        selectedMod
          ? `filtered: ${stream.snapshot?.mods.find((m) => m.packageId === selectedMod)?.name ?? selectedMod}`
          : `${patches.length}/${allPatches.length} methods`
      }
      rightSlot={
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter method"
          className="rounded border border-line bg-paper px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] outline-none placeholder:text-subtle focus:border-ink/40"
        />
      }
    >
      {conflicts.length > 0 && (
        <div className="mb-3 flex flex-col gap-1.5 rounded border border-failed/30 bg-failed/5 p-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-failed">
            ⚠ {conflicts.length} conflict{conflicts.length > 1 ? 's' : ''}
          </div>
          {conflicts.slice(0, 6).map((c, i) => (
            <div key={i} className="font-mono text-[11px] text-ink">
              <span className="text-failed">{kindLabel(c.kind)}</span>{' '}
              <span className="text-muted">on</span>{' '}
              <span className="text-ink">{c.subject}</span>
              <span className="ml-1 text-subtle">— {c.mods.join(', ')}</span>
            </div>
          ))}
        </div>
      )}

      {patches.length === 0 ? (
        <div className="px-2 py-6 text-center font-mono text-[11px] text-subtle">
          {stream.snapshot ? 'No patches matched.' : 'Awaiting snapshot…'}
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-line/40">
          {patches.slice(0, 250).map((p) => (
            <div key={p.method} className="py-1.5 font-mono text-[11px]">
              <div className="flex items-center gap-2">
                <span className="truncate text-ink">{p.method}</span>
                {p.destructiveBy.length > 0 && (
                  <span className="rounded bg-failed/15 px-1 py-0.5 text-[9px] uppercase tracking-[0.18em] text-failed">
                    destructive
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-subtle">
                <PatchLine label="pre" mods={p.prefixes} highlight={p.destructiveBy} />
                <PatchLine label="post" mods={p.postfixes} />
                <PatchLine label="tpl" mods={p.transpilers} warn={p.transpilers.length > 1} />
                {p.finalizers.length > 0 && (
                  <PatchLine label="fin" mods={p.finalizers} />
                )}
              </div>
            </div>
          ))}
          {patches.length > 250 && (
            <div className="py-2 text-center font-mono text-[10px] text-subtle">
              …{patches.length - 250} more
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function PatchLine({
  label,
  mods,
  highlight,
  warn,
}: {
  label: string;
  mods: string[];
  highlight?: string[];
  warn?: boolean;
}) {
  if (mods.length === 0) return null;
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-subtle">{label}</span>
      <span className={cn(warn && 'text-accent')}>
        {mods
          .map((m) =>
            highlight?.includes(m) ? (
              <span key={m} className="text-failed">
                {m}
              </span>
            ) : (
              <span key={m} className="text-muted">
                {m}
              </span>
            ),
          )
          .reduce<React.ReactNode[]>((acc, el, i) => {
            if (i > 0) acc.push(<span key={`s${i}`}>, </span>);
            acc.push(el);
            return acc;
          }, [])}
      </span>
    </span>
  );
}

function kindLabel(k: string): string {
  switch (k) {
    case 'double_destructive_prefix':
      return 'destructive prefix collision';
    case 'duplicate_harmony_id':
      return 'duplicate harmony id';
    case 'stacked_transpilers':
      return 'stacked transpilers';
    default:
      return k;
  }
}
