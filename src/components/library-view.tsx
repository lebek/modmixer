import { useEffect, useMemo, useState, useCallback } from 'react';
import { cn } from '@/lib/cn';
import { appAlert } from './app-dialog';
import type { EnableWithDepsResult, RegistryEnvelope } from '../preload';
import type {
  ActiveSession,
  ModIssue,
  RegistryMod,
} from '../agent/registry';
import { CORE_PACKAGE_ID } from './library/badges';
import { Column } from './library/columns';
import { ModRow, MissingRow } from './library/rows';
import { ModInfoPanel } from './library/info-panel';
import { SessionBanner } from './library/session-banner';

type SourceFilter = 'all' | 'official' | 'local' | 'workshop' | 'workspace';
type ColumnFilter = 'all' | 'issues';

export function LibraryView({
  envelope,
  session,
  onRefresh,
  onAutosort,
  onSetActive,
  onEnableWithDeps,
  // onStartFix is kept on the prop signature so callers don't have to be
  // touched, but the button that invoked it is hidden for now — so we
  // intentionally don't destructure it.
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
        void appAlert(msg);
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
          {/* "Start fix session" button hidden until the modlist-fix flow
              is fully wired up (matching the agent-side hidden tools and
              system-prompt block). Re-enable this when bringing the feature
              back. */}
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
          loadOrder={selectedPid ? activeOrder.indexOf(selectedPid) : -1}
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
