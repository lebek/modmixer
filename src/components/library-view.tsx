import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/cn';
import type { EnableWithDepsResult, RegistryEnvelope } from '../preload';
import type {
  ActiveSession,
  ModIssue,
  RegistryMod,
} from '../agent/registry';

type SourceFilter = 'all' | 'official' | 'local' | 'workshop' | 'workspace';
type ColumnFilter = 'all' | 'issues';

export function LibraryView({
  envelope,
  session,
  onRefresh,
  onAutosort,
  onSetActive,
  onEnableWithDeps,
  onStartFix,
  onApplySession,
  onRevertSession,
}: {
  envelope: RegistryEnvelope | null;
  session: ActiveSession | null;
  onRefresh: () => Promise<void>;
  onAutosort: () => Promise<void>;
  onSetActive: (packageIds: string[]) => Promise<void>;
  onEnableWithDeps: (packageId: string) => Promise<EnableWithDepsResult>;
  onStartFix: () => Promise<void>;
  onApplySession: () => Promise<void>;
  onRevertSession: () => Promise<void>;
}) {
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [columnFilter, setColumnFilter] = useState<ColumnFilter>('all');
  const [busy, setBusy] = useState(false);
  const [autosortPreview, setAutosortPreview] = useState<string | null>(null);
  const [selectedPid, setSelectedPid] = useState<string | null>(null);

  const mods = envelope?.snapshot.mods ?? [];
  const activeOrder = envelope?.snapshot.activeOrder ?? [];
  const issuesByPid = useMemo(() => {
    const m = new Map<string, ModIssue[]>();
    if (!envelope) return m;
    // Map traverses cleanly across IPC; defensive copy.
    const src = envelope.analysis.byPackageId;
    if (src instanceof Map) {
      for (const [k, v] of src) m.set(k, v);
    } else if (src && typeof src === 'object') {
      for (const [k, v] of Object.entries(src as Record<string, ModIssue[]>)) {
        m.set(k, v);
      }
    }
    return m;
  }, [envelope]);

  const byPackageId = useMemo(() => {
    const m = new Map<string, RegistryMod>();
    for (const mod of mods) {
      if (mod.about.packageIdLc) m.set(mod.about.packageIdLc, mod);
    }
    return m;
  }, [mods]);

  const matchesSearch = useCallback(
    (mod: RegistryMod) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        mod.about.name.toLowerCase().includes(q) ||
        mod.about.packageIdLc.includes(q) ||
        mod.folder.toLowerCase().includes(q) ||
        mod.about.author.toLowerCase().includes(q)
      );
    },
    [search],
  );
  const matchesSource = useCallback(
    (mod: RegistryMod) => sourceFilter === 'all' || mod.source === sourceFilter,
    [sourceFilter],
  );
  const matchesColumn = useCallback(
    (mod: RegistryMod) =>
      columnFilter === 'all' ||
      (issuesByPid.get(mod.about.packageIdLc)?.length ?? 0) > 0,
    [columnFilter, issuesByPid],
  );

  const activeMods = useMemo(() => {
    const out: { packageId: string; mod: RegistryMod | null; loadOrder: number }[] = [];
    for (let i = 0; i < activeOrder.length; i++) {
      const pid = activeOrder[i];
      const mod = byPackageId.get(pid) ?? null;
      out.push({ packageId: pid, mod, loadOrder: i + 1 });
    }
    return out.filter(({ mod }) => {
      if (!mod) return columnFilter === 'all';
      return matchesSearch(mod) && matchesSource(mod) && matchesColumn(mod);
    });
  }, [activeOrder, byPackageId, matchesSearch, matchesSource, matchesColumn, columnFilter]);

  const inactiveMods = useMemo(() => {
    const activeSet = new Set(activeOrder);
    return mods
      .filter((m) => !activeSet.has(m.about.packageIdLc))
      .filter((m) => matchesSearch(m) && matchesSource(m) && matchesColumn(m))
      .sort((a, b) => a.about.name.localeCompare(b.about.name));
  }, [mods, activeOrder, matchesSearch, matchesSource, matchesColumn]);

  useEffect(() => {
    setAutosortPreview(null);
  }, [envelope]);

  const guarded = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        window.alert(msg);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const [resolveBanner, setResolveBanner] = useState<string | null>(null);

  const enable = useCallback(
    (mod: RegistryMod) =>
      guarded(async () => {
        if (!mod.about.packageIdLc) return;
        // Workspace mods need a symlink in RimWorld's Mods/ before RimWorld
        // can resolve the packageId. The Library tab is allowed to gloss
        // over that detail — clicking Enable should make the mod actually
        // load in-game, not just appear in <activeMods>.
        if (mod.source === 'workspace') {
          await window.modmixer.syncModToGame(mod.folder);
        }
        const res = await onEnableWithDeps(mod.about.packageIdLc);
        const depCount = res.added.filter((p) => p !== mod.about.packageIdLc).length;
        const parts: string[] = [];
        if (depCount > 0) {
          parts.push(
            `Also enabled ${depCount} dep${depCount === 1 ? '' : 's'}: ${res.added.filter((p) => p !== mod.about.packageIdLc).join(', ')}.`,
          );
        }
        if (res.missing.length > 0) {
          parts.push(
            `Missing on disk: ${res.missing.join(', ')}. Install before launching.`,
          );
        }
        if (parts.length > 0) setResolveBanner(parts.join(' '));
      }),
    [guarded, onEnableWithDeps],
  );
  const resolveDeps = useCallback(
    (mod: RegistryMod) =>
      guarded(async () => {
        if (!mod.about.packageIdLc) return;
        const res = await onEnableWithDeps(mod.about.packageIdLc);
        if (res.added.length === 0 && res.missing.length === 0) {
          setResolveBanner('No deps to resolve.');
          return;
        }
        const parts: string[] = [];
        if (res.added.length > 0) {
          parts.push(
            `Enabled ${res.added.length} dep${res.added.length === 1 ? '' : 's'}: ${res.added.join(', ')}.`,
          );
        }
        if (res.missing.length > 0) {
          parts.push(
            `Still missing on disk: ${res.missing.join(', ')}. Install before launching.`,
          );
        }
        setResolveBanner(parts.join(' '));
      }),
    [guarded, onEnableWithDeps],
  );
  // Disable = remove from <activeMods> only. The workspace symlink (and any
  // other mod's folder) stays in place so the mod remains visible in
  // RimWorld's mod list as inactive — same as Workshop/local mods.
  const disable = useCallback(
    (pid: string) =>
      guarded(async () => {
        const next = activeOrder.filter((p) => p !== pid);
        await onSetActive(next);
      }),
    [activeOrder, guarded, onSetActive],
  );
  const moveUp = useCallback(
    (pid: string) =>
      guarded(async () => {
        const idx = activeOrder.indexOf(pid);
        if (idx <= 0) return;
        const next = activeOrder.slice();
        [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
        await onSetActive(next);
      }),
    [activeOrder, guarded, onSetActive],
  );
  const moveDown = useCallback(
    (pid: string) =>
      guarded(async () => {
        const idx = activeOrder.indexOf(pid);
        if (idx < 0 || idx >= activeOrder.length - 1) return;
        const next = activeOrder.slice();
        [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
        await onSetActive(next);
      }),
    [activeOrder, guarded, onSetActive],
  );

  const canMutate = !busy;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {session && (
        <SessionBanner
          session={session}
          onApply={() => guarded(onApplySession)}
          onRevert={() => guarded(onRevertSession)}
        />
      )}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface/30 px-5 py-2">
        <input
          type="search"
          placeholder="Search mods…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 flex-1 rounded-md border border-line bg-paper px-2 text-xs"
        />
        <SourceSelect value={sourceFilter} onChange={setSourceFilter} />
        <button
          onClick={() =>
            setColumnFilter((c) => (c === 'all' ? 'issues' : 'all'))
          }
          className={cn(
            'h-7 rounded-md border px-2 text-[11px] uppercase tracking-wide transition-colors',
            columnFilter === 'issues'
              ? 'border-amber-500 bg-amber-500/10 text-amber-700'
              : 'border-line text-muted hover:border-ink/40',
          )}
        >
          {columnFilter === 'issues' ? 'Showing issues only' : 'Show issues only'}
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button
            disabled={!canMutate}
            onClick={() => guarded(onAutosort)}
            className="h-7 rounded-md border border-line px-3 text-[11px] uppercase tracking-wide text-muted hover:border-ink/40 disabled:opacity-50"
          >
            Autosort
          </button>
          {!session && (
            <button
              disabled={!canMutate}
              onClick={() => guarded(onStartFix)}
              className="h-7 rounded-md border border-line px-3 text-[11px] uppercase tracking-wide text-muted hover:border-ink/40 disabled:opacity-50"
            >
              Start fix session
            </button>
          )}
          <button
            disabled={!canMutate}
            onClick={() => guarded(onRefresh)}
            className="h-7 rounded-md border border-line px-3 text-[11px] uppercase tracking-wide text-muted hover:border-ink/40 disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </div>
      {(autosortPreview || resolveBanner) && (
        <div className="flex items-start justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-5 py-2 text-xs text-amber-900">
          <span>{resolveBanner ?? autosortPreview}</span>
          <button
            onClick={() => {
              setResolveBanner(null);
              setAutosortPreview(null);
            }}
            className="font-mono text-[10px] uppercase tracking-wide hover:underline"
          >
            dismiss
          </button>
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        <ModInfoPanel
          selectedPid={selectedPid}
          mod={selectedPid ? byPackageId.get(selectedPid) ?? null : null}
          loadOrder={
            selectedPid ? activeOrder.indexOf(selectedPid) : -1
          }
          issues={selectedPid ? issuesByPid.get(selectedPid) ?? [] : []}
          allMods={byPackageId}
          onSelectPid={setSelectedPid}
          onClose={() => setSelectedPid(null)}
        />
        <Column
          title={`Inactive (${inactiveMods.length})`}
          subtitle="Available on disk"
          empty="No inactive mods match the current filters."
          items={inactiveMods}
          getKey={(mod) =>
            `${mod.source}:${mod.folder}:${mod.about.packageIdLc}`
          }
          renderItem={(mod) => (
            <ModRow
              mod={mod}
              loadOrder={null}
              issues={issuesByPid.get(mod.about.packageIdLc) ?? []}
              onPrimary={() => enable(mod)}
              primaryLabel="Enable"
              disabled={!canMutate || !mod.about.packageId}
              selected={selectedPid === mod.about.packageIdLc}
              onSelect={() => setSelectedPid(mod.about.packageIdLc)}
            />
          )}
        />
        <Column
          title={`Active (${activeMods.length})`}
          subtitle="Loaded by RimWorld in this order"
          empty="No active mods match the current filters."
          items={activeMods}
          getKey={(row) =>
            row.mod ? `active:${row.packageId}` : `missing:${row.packageId}`
          }
          renderItem={({ packageId, mod, loadOrder }) => {
            if (!mod) {
              return (
                <MissingRow
                  packageId={packageId}
                  loadOrder={loadOrder}
                  onRemove={() => disable(packageId)}
                  disabled={!canMutate}
                  selected={selectedPid === packageId}
                  onSelect={() => setSelectedPid(packageId)}
                />
              );
            }
            const isCore = packageId === CORE_PACKAGE_ID;
            const rowIssues = issuesByPid.get(packageId) ?? [];
            const hasMissingDeps = rowIssues.some(
              (i) => i.kind === 'missing-dependency',
            );
            return (
              <ModRow
                mod={mod}
                loadOrder={loadOrder}
                issues={rowIssues}
                onPrimary={() => disable(packageId)}
                primaryLabel="Disable"
                hidePrimary={isCore}
                onMoveUp={isCore ? undefined : () => moveUp(packageId)}
                onMoveDown={isCore ? undefined : () => moveDown(packageId)}
                onResolveDeps={
                  hasMissingDeps ? () => resolveDeps(mod) : undefined
                }
                disabled={!canMutate}
                selected={selectedPid === packageId}
                onSelect={() => setSelectedPid(packageId)}
              />
            );
          }}
        />
      </div>
    </div>
  );
}

function SourceSelect({
  value,
  onChange,
}: {
  value: SourceFilter;
  onChange: (v: SourceFilter) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as SourceFilter)}
      className="h-7 rounded-md border border-line bg-paper px-2 text-xs"
    >
      <option value="all">All sources</option>
      <option value="official">Official (Core/DLC)</option>
      <option value="local">Local</option>
      <option value="workshop">Workshop</option>
      <option value="workspace">Workspace</option>
    </select>
  );
}

function Column<T>({
  title,
  subtitle,
  empty,
  items,
  getKey,
  renderItem,
}: {
  title: string;
  subtitle: string;
  empty: string;
  items: T[];
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col overflow-hidden border-r border-line last:border-r-0">
      <div className="border-b border-line bg-surface/40 px-4 py-2">
        <div className="font-display text-sm font-medium text-ink">{title}</div>
        <div className="text-[11px] text-muted">{subtitle}</div>
      </div>
      {items.length === 0 ? (
        <div className="flex-1 overflow-auto p-6 text-center text-xs text-muted">
          {empty}
        </div>
      ) : (
        <VirtualRows items={items} getKey={getKey} renderItem={renderItem} />
      )}
    </div>
  );
}

function VirtualRows<T>({
  items,
  getKey,
  renderItem,
}: {
  items: T[];
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    // ModRow is two text lines + py-2 padding; measureElement corrects
    // for rows that wrap badges onto a second line.
    estimateSize: () => 52,
    overscan: 8,
    getItemKey: (index) => getKey(items[index], index),
  });
  return (
    <div ref={parentRef} className="flex-1 overflow-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => (
          <div
            key={virtualRow.key}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`,
            }}
            className="border-b border-line"
          >
            {renderItem(items[virtualRow.index], virtualRow.index)}
          </div>
        ))}
      </div>
    </div>
  );
}

function ModRow({
  mod,
  loadOrder,
  issues,
  onPrimary,
  primaryLabel,
  onMoveUp,
  onMoveDown,
  disabled,
  hidePrimary,
  onResolveDeps,
  selected,
  onSelect,
}: {
  mod: RegistryMod;
  loadOrder: number | null;
  issues: ModIssue[];
  onPrimary: () => void;
  primaryLabel: string;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  disabled?: boolean;
  hidePrimary?: boolean;
  onResolveDeps?: () => void;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const isCore = mod.about.packageIdLc === CORE_PACKAGE_ID;
  return (
    <div
      onClick={onSelect}
      className={cn(
        'group flex cursor-pointer items-start gap-3 px-4 py-2 hover:bg-raised/40',
        selected && 'bg-accent/10 hover:bg-accent/10',
      )}
    >
      <div className="w-12 shrink-0 pt-1 text-right font-mono text-[11px] text-muted">
        {loadOrder !== null ? `#${loadOrder}` : ''}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm text-ink" title={mod.about.name}>
            {mod.about.name || mod.folder}
          </span>
          <SourceBadge source={mod.source} isCore={isCore} />
          {mod.hasDlls && <Badge tone="neutral">DLL</Badge>}
          {issues.map((issue, i) => (
            <Badge
              key={i}
              tone={issue.kind === 'incompatible-mod-active' ? 'error' : 'warn'}
              title={issue.message}
            >
              {shortIssue(issue.kind)}
            </Badge>
          ))}
        </div>
        <div className="truncate text-[11px] text-muted">
          {mod.about.packageId || mod.folder}
          {mod.about.author && <> — {mod.about.author}</>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        {onMoveUp && (
          <IconButton onClick={onMoveUp} disabled={disabled} label="Move up">
            ↑
          </IconButton>
        )}
        {onMoveDown && (
          <IconButton onClick={onMoveDown} disabled={disabled} label="Move down">
            ↓
          </IconButton>
        )}
        {onResolveDeps && (
          <button
            onClick={onResolveDeps}
            disabled={disabled}
            title="Enable installed dependencies"
            className="rounded-md border border-amber-500/50 bg-paper px-2 py-0.5 text-[11px] uppercase tracking-wide text-amber-700 hover:bg-amber-500/10 disabled:opacity-50"
          >
            +deps
          </button>
        )}
        {!hidePrimary && (
          <button
            onClick={onPrimary}
            disabled={disabled}
            className="rounded-md border border-line px-2 py-0.5 text-[11px] uppercase tracking-wide text-muted hover:border-ink/40 hover:text-ink disabled:opacity-50"
          >
            {primaryLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function MissingRow({
  packageId,
  loadOrder,
  onRemove,
  disabled,
  selected,
  onSelect,
}: {
  packageId: string;
  loadOrder: number;
  onRemove: () => void;
  disabled?: boolean;
  selected?: boolean;
  onSelect?: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={cn(
        'flex cursor-pointer items-start gap-3 px-4 py-2 hover:bg-raised/40',
        selected && 'bg-accent/10 hover:bg-accent/10',
      )}
    >
      <div className="w-12 shrink-0 pt-1 text-right font-mono text-[11px] text-muted">
        #{loadOrder}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm italic text-muted">{packageId}</span>
          <Badge tone="error" title="Active in ModsConfig.xml but no folder found on disk">
            missing
          </Badge>
        </div>
        <div className="text-[11px] text-muted">
          Active but not installed. Either install the mod or remove it from the list.
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={onRemove}
          disabled={disabled}
          className="rounded-md border border-line px-2 py-0.5 text-[11px] uppercase tracking-wide text-muted hover:border-ink/40 hover:text-ink disabled:opacity-50"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function SourceBadge({
  source,
  isCore,
}: {
  source: RegistryMod['source'];
  isCore?: boolean;
}) {
  const label = isCore
    ? 'Core'
    : source === 'official'
    ? 'DLC'
    : source === 'workshop'
    ? 'Workshop'
    : source === 'workspace'
    ? 'Workspace'
    : 'Local';
  const cls = isCore
    ? 'bg-amber-500/15 text-amber-700 border-amber-500/30'
    : source === 'official'
    ? 'bg-violet-500/15 text-violet-700 border-violet-500/30'
    : source === 'workshop'
    ? 'bg-sky-500/15 text-sky-700 border-sky-500/30'
    : source === 'workspace'
    ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30'
    : 'bg-stone-500/15 text-stone-700 border-stone-500/30';
  return (
    <span
      className={cn(
        'rounded border px-1 py-0.5 font-mono text-[9px] uppercase tracking-wide',
        cls,
      )}
    >
      {label}
    </span>
  );
}

function Badge({
  children,
  tone,
  title,
}: {
  children: React.ReactNode;
  tone: 'neutral' | 'warn' | 'error';
  title?: string;
}) {
  const cls =
    tone === 'warn'
      ? 'bg-amber-500/15 text-amber-700 border-amber-500/30'
      : tone === 'error'
      ? 'bg-red-500/15 text-red-700 border-red-500/30'
      : 'bg-stone-500/10 text-muted border-line';
  return (
    <span
      title={title}
      className={cn(
        'rounded border px-1 py-0.5 font-mono text-[9px] uppercase tracking-wide',
        cls,
      )}
    >
      {children}
    </span>
  );
}

function IconButton({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded-md border border-line px-1.5 text-xs text-muted hover:border-ink/40 hover:text-ink disabled:opacity-50"
    >
      {children}
    </button>
  );
}

const CORE_PACKAGE_ID = 'ludeon.rimworld';

function shortIssue(kind: ModIssue['kind']): string {
  switch (kind) {
    case 'missing-dependency':
      return 'missing dep';
    case 'incompatible-mod-active':
      return 'incompat';
    case 'load-order-violation':
      return 'order';
    case 'version-incompat':
      return 'version';
  }
}

function SessionBanner({
  session,
  onApply,
  onRevert,
}: {
  session: ActiveSession;
  onApply: () => void;
  onRevert: () => void;
}) {
  const label =
    session.type === 'test'
      ? `Testing ${session.testTarget?.folder ?? 'mod'} in isolation`
      : 'Fix session in progress';
  return (
    <div className="flex items-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-5 py-2 text-sm">
      <span
        className="h-2 w-2 rounded-full bg-amber-500 animate-pulse"
        aria-hidden
      />
      <span className="font-medium text-amber-900">{label}</span>
      <span className="text-xs text-amber-900/80">
        Started {new Date(session.startedAt).toLocaleTimeString()}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={onRevert}
          className="rounded-md border border-amber-500/40 bg-paper px-3 py-1 text-[11px] uppercase tracking-wide text-amber-900 hover:bg-amber-500/10"
        >
          Revert
        </button>
        <button
          onClick={onApply}
          className="rounded-md bg-amber-500 px-3 py-1 text-[11px] uppercase tracking-wide text-paper hover:bg-amber-600"
        >
          Apply
        </button>
      </div>
    </div>
  );
}

function ModInfoPanel({
  selectedPid,
  mod,
  loadOrder,
  issues,
  allMods,
  onSelectPid,
  onClose,
}: {
  selectedPid: string | null;
  mod: RegistryMod | null;
  /** -1 if not active. */
  loadOrder: number;
  issues: ModIssue[];
  allMods: Map<string, RegistryMod>;
  onSelectPid: (pid: string) => void;
  onClose: () => void;
}) {
  if (!selectedPid) {
    return (
      <aside className="flex w-80 shrink-0 flex-col border-r border-line bg-surface/20">
        <div className="border-b border-line bg-surface/40 px-4 py-2">
          <div className="font-display text-sm font-medium text-ink">Details</div>
          <div className="text-[11px] text-muted">Select a mod to see info</div>
        </div>
        <div className="flex-1 overflow-auto p-6 text-center text-xs text-muted">
          No mod selected.
        </div>
      </aside>
    );
  }

  if (!mod) {
    return (
      <aside className="flex w-80 shrink-0 flex-col border-r border-line bg-surface/20">
        <PanelHeader
          title="Missing mod"
          subtitle="Active in ModsConfig.xml but not on disk"
          onClose={onClose}
        />
        <div className="flex-1 overflow-auto px-4 py-4 space-y-3">
          <div>
            <div className="font-mono text-xs text-ink break-all">
              {selectedPid}
            </div>
            <div className="mt-1 text-[11px] text-muted">
              Either install the mod or remove it from the active list.
            </div>
          </div>
          {loadOrder >= 0 && (
            <Field label="Load order">#{loadOrder + 1}</Field>
          )}
        </div>
      </aside>
    );
  }

  const isCore = mod.about.packageIdLc === CORE_PACKAGE_ID;
  const workshopUrl = mod.publishedFileId
    ? `https://steamcommunity.com/sharedfiles/filedetails/?id=${mod.publishedFileId}`
    : null;

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-surface/20">
      <PanelHeader
        title={mod.about.name || mod.folder}
        subtitle={mod.about.author || ' '}
        onClose={onClose}
      />
      <div className="flex-1 overflow-auto px-4 py-4 space-y-4 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <SourceBadge source={mod.source} isCore={isCore} />
          {mod.hasDlls && <Badge tone="neutral">DLL</Badge>}
          {loadOrder >= 0 ? (
            <Badge tone="neutral">#{loadOrder + 1} active</Badge>
          ) : (
            <Badge tone="neutral">inactive</Badge>
          )}
          {mod.source === 'workspace' && (
            <Badge tone="neutral">
              {mod.workspaceSynced ? 'synced' : 'not synced'}
            </Badge>
          )}
        </div>

        {mod.about.packageId && (
          <Field label="Package ID">
            <span className="font-mono text-[11px] break-all">
              {mod.about.packageId}
            </span>
          </Field>
        )}

        {mod.about.supportedVersions.length > 0 && (
          <Field label="Supported versions">
            {mod.about.supportedVersions.join(', ')}
          </Field>
        )}

        <Field label="Folder">
          <button
            onClick={() => void window.modmixer.openFolder(mod.path)}
            className="font-mono text-[11px] text-ink hover:underline break-all text-left"
            title="Open in file manager"
          >
            {mod.folder}
          </button>
        </Field>

        {workshopUrl && (
          <Field label="Workshop">
            <button
              onClick={() => void window.modmixer.openExternal(workshopUrl)}
              className="text-ink hover:underline"
            >
              {mod.publishedFileId}
            </button>
          </Field>
        )}

        {mod.about.description && (
          <Field label="Description">
            <p className="whitespace-pre-line text-[11px] text-ink leading-relaxed">
              {mod.about.description}
            </p>
          </Field>
        )}

        {issues.length > 0 && (
          <Field label={`Issues (${issues.length})`}>
            <ul className="space-y-1">
              {issues.map((issue, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <Badge
                    tone={
                      issue.kind === 'incompatible-mod-active' ? 'error' : 'warn'
                    }
                  >
                    {shortIssue(issue.kind)}
                  </Badge>
                  <span className="text-[11px] text-ink leading-relaxed">
                    {issue.message}
                  </span>
                </li>
              ))}
            </ul>
          </Field>
        )}

        {mod.about.modDependencies.length > 0 && (
          <Field label="Required dependencies">
            <PidList
              pids={mod.about.modDependencies.map((d) => ({
                pid: d.packageIdLc,
                label: d.displayName || d.packageId,
              }))}
              allMods={allMods}
              onSelectPid={onSelectPid}
            />
          </Field>
        )}

        {mod.about.loadAfter.length > 0 && (
          <Field label="Load after">
            <PidList
              pids={mod.about.loadAfter.map((p) => ({ pid: p, label: p }))}
              allMods={allMods}
              onSelectPid={onSelectPid}
            />
          </Field>
        )}

        {mod.about.loadBefore.length > 0 && (
          <Field label="Load before">
            <PidList
              pids={mod.about.loadBefore.map((p) => ({ pid: p, label: p }))}
              allMods={allMods}
              onSelectPid={onSelectPid}
            />
          </Field>
        )}

        {mod.about.incompatibleWith.length > 0 && (
          <Field label="Incompatible with">
            <PidList
              pids={mod.about.incompatibleWith.map((p) => ({
                pid: p,
                label: p,
              }))}
              allMods={allMods}
              onSelectPid={onSelectPid}
            />
          </Field>
        )}
      </div>
    </aside>
  );
}

function PanelHeader({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start gap-2 border-b border-line bg-surface/40 px-4 py-2">
      <div className="min-w-0 flex-1">
        <div
          className="truncate font-display text-sm font-medium text-ink"
          title={title}
        >
          {title}
        </div>
        <div className="truncate text-[11px] text-muted" title={subtitle}>
          {subtitle}
        </div>
      </div>
      <button
        onClick={onClose}
        aria-label="Close details"
        title="Close"
        className="shrink-0 rounded-md border border-line px-1.5 text-xs text-muted hover:border-ink/40 hover:text-ink"
      >
        ×
      </button>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-subtle">
        {label}
      </div>
      <div className="text-[11px] text-ink">{children}</div>
    </div>
  );
}

function PidList({
  pids,
  allMods,
  onSelectPid,
}: {
  pids: { pid: string; label: string }[];
  allMods: Map<string, RegistryMod>;
  onSelectPid: (pid: string) => void;
}) {
  return (
    <ul className="space-y-1">
      {pids.map(({ pid, label }) => {
        const installed = allMods.has(pid);
        return (
          <li key={pid} className="flex items-center gap-1.5">
            {installed ? (
              <button
                onClick={() => onSelectPid(pid)}
                className="text-left text-ink hover:underline truncate"
                title={pid}
              >
                {label}
              </button>
            ) : (
              <span className="text-muted truncate" title={pid}>
                {label}
              </span>
            )}
            {!installed && (
              <Badge tone="warn" title="Not installed on this machine">
                missing
              </Badge>
            )}
          </li>
        );
      })}
    </ul>
  );
}
