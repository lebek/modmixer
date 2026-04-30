import { useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import type { MonitorStream } from './use-monitor-stream';
import { Panel } from './perf-panel';

type SortKey = 'load' | 'patches' | 'destructive';

export function ModsPanel({
  stream,
  onSelectMod,
}: {
  stream: MonitorStream;
  onSelectMod: (packageId: string | null) => void;
}) {
  const [sort, setSort] = useState<SortKey>('load');
  const [selected, setSelected] = useState<string | null>(null);

  const mods = useMemo(() => {
    const list = stream.snapshot?.mods ?? [];
    const copy = list.slice();
    if (sort === 'patches') copy.sort((a, b) => b.patchCount - a.patchCount);
    if (sort === 'destructive')
      copy.sort((a, b) => b.destructivePrefixCount - a.destructivePrefixCount);
    if (sort === 'load') copy.sort((a, b) => a.loadOrder - b.loadOrder);
    return copy;
  }, [stream.snapshot, sort]);

  const select = (id: string | null) => {
    setSelected(id);
    onSelectMod(id);
  };

  return (
    <Panel
      title={`mods · ${mods.length}`}
      subtitle={
        stream.snapshot
          ? `${stream.snapshot.patches.length} patched methods`
          : 'awaiting snapshot'
      }
      rightSlot={
        <div className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.18em]">
          <SortBtn k="load" active={sort} onClick={setSort}>
            order
          </SortBtn>
          <SortBtn k="patches" active={sort} onClick={setSort}>
            patches
          </SortBtn>
          <SortBtn k="destructive" active={sort} onClick={setSort}>
            destructive
          </SortBtn>
        </div>
      }
    >
      {mods.length === 0 ? (
        <Empty>No mod data — bridge will publish a snapshot on connect.</Empty>
      ) : (
        <div className="flex flex-col">
          {mods.map((m) => (
            <button
              key={m.packageId}
              onClick={() => select(selected === m.packageId ? null : m.packageId)}
              className={cn(
                'group grid grid-cols-[2.5rem_1fr_3.5rem_3.5rem_3rem] items-center gap-3 px-1.5 py-1.5 text-left font-mono text-[11px] hover:bg-raised/40',
                selected === m.packageId && 'bg-raised/60',
              )}
            >
              <span className="tabular-nums text-subtle">
                {String(m.loadOrder).padStart(3, '0')}
              </span>
              <span className="truncate text-ink">
                {m.name}
                {m.hasAssemblies && (
                  <span className="ml-2 text-[9px] uppercase tracking-[0.18em] text-subtle">
                    asm·{m.assemblyCount}
                  </span>
                )}
              </span>
              <span className="tabular-nums text-right text-muted">
                {m.patchCount}
              </span>
              <span
                className={cn(
                  'tabular-nums text-right',
                  m.destructivePrefixCount > 0 ? 'text-failed' : 'text-subtle',
                )}
              >
                {m.destructivePrefixCount}
              </span>
              <span className="text-right text-subtle text-[10px] uppercase tracking-[0.18em]">
                {m.hasAssemblies ? 'c#' : 'xml'}
              </span>
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}

function SortBtn<T extends string>({
  k,
  active,
  onClick,
  children,
}: {
  k: T;
  active: T;
  onClick: (k: T) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={() => onClick(k)}
      className={cn(
        'rounded px-1.5 py-0.5 transition-colors',
        active === k ? 'bg-ink text-paper' : 'text-subtle hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 py-6 text-center font-mono text-[11px] text-subtle">
      {children}
    </div>
  );
}
