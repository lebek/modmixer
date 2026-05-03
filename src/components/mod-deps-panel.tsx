import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceMod } from '../agent/workspace';
import type { ModDependency } from '../agent/registry';
import type { RegistryEnvelope } from '../preload';
import { cn } from '@/lib/cn';

export function ModDepsPanel({ mod }: { mod: WorkspaceMod }) {
  const [registry, setRegistry] = useState<RegistryEnvelope | null>(null);
  const [deps, setDeps] = useState<ModDependency[]>(mod.about.modDependencies ?? []);
  const [loadAfter, setLoadAfter] = useState<string[]>(mod.about.loadAfter ?? []);
  const [loadBefore, setLoadBefore] = useState<string[]>(mod.about.loadBefore ?? []);
  const [incompat, setIncompat] = useState<string[]>(
    mod.about.incompatibleWith ?? [],
  );
  const [picker, setPicker] = useState<null | 'dep' | 'after' | 'before' | 'incompat'>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);

  // Re-sync local state when the mod prop changes (e.g. agent edited About.xml).
  useEffect(() => {
    setDeps(mod.about.modDependencies ?? []);
    setLoadAfter(mod.about.loadAfter ?? []);
    setLoadBefore(mod.about.loadBefore ?? []);
    setIncompat(mod.about.incompatibleWith ?? []);
  }, [
    mod.folder,
    mod.about.modDependencies,
    mod.about.loadAfter,
    mod.about.loadBefore,
    mod.about.incompatibleWith,
  ]);

  useEffect(() => {
    void window.modmixer.getRegistry().then(setRegistry);
    return window.modmixer.onRegistryChanged(setRegistry);
  }, []);

  const allMods = registry?.snapshot.mods ?? [];
  const candidatePool = useMemo(
    () =>
      allMods
        .filter((m) => m.about.packageId && m.about.packageIdLc !== mod.about.packageId.toLowerCase())
        .sort((a, b) => a.about.name.localeCompare(b.about.name)),
    [allMods, mod.about.packageId],
  );

  const save = async (
    next: Partial<{
      modDependencies: ModDependency[];
      loadAfter: string[];
      loadBefore: string[];
      incompatibleWith: string[];
    }>,
  ) => {
    setBusy(true);
    try {
      await window.modmixer.writeModDeps(mod.folder, {
        modDependencies: next.modDependencies ?? deps,
        loadAfter: next.loadAfter ?? loadAfter,
        loadBefore: next.loadBefore ?? loadBefore,
        incompatibleWith: next.incompatibleWith ?? incompat,
      });
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addDep = async (packageId: string, displayName: string) => {
    if (deps.some((d) => d.packageIdLc === packageId.toLowerCase())) return;
    const next: ModDependency = {
      packageId,
      packageIdLc: packageId.toLowerCase(),
      displayName,
      steamWorkshopUrl: '',
      downloadUrl: '',
    };
    const updated = [...deps, next];
    setDeps(updated);
    await save({ modDependencies: updated });
  };
  const removeDep = async (lc: string) => {
    const updated = deps.filter((d) => d.packageIdLc !== lc);
    setDeps(updated);
    await save({ modDependencies: updated });
  };
  const addList = async (
    list: 'after' | 'before' | 'incompat',
    packageId: string,
  ) => {
    const lc = packageId.toLowerCase();
    if (list === 'after') {
      if (loadAfter.includes(lc)) return;
      const updated = [...loadAfter, lc];
      setLoadAfter(updated);
      await save({ loadAfter: updated });
    } else if (list === 'before') {
      if (loadBefore.includes(lc)) return;
      const updated = [...loadBefore, lc];
      setLoadBefore(updated);
      await save({ loadBefore: updated });
    } else {
      if (incompat.includes(lc)) return;
      const updated = [...incompat, lc];
      setIncompat(updated);
      await save({ incompatibleWith: updated });
    }
  };
  const removeList = async (
    list: 'after' | 'before' | 'incompat',
    lc: string,
  ) => {
    if (list === 'after') {
      const updated = loadAfter.filter((p) => p !== lc);
      setLoadAfter(updated);
      await save({ loadAfter: updated });
    } else if (list === 'before') {
      const updated = loadBefore.filter((p) => p !== lc);
      setLoadBefore(updated);
      await save({ loadBefore: updated });
    } else {
      const updated = incompat.filter((p) => p !== lc);
      setIncompat(updated);
      await save({ incompatibleWith: updated });
    }
  };

  const onPick = (packageId: string, name: string) => {
    if (picker === 'dep') void addDep(packageId, name);
    else if (picker === 'after') void addList('after', packageId);
    else if (picker === 'before') void addList('before', packageId);
    else if (picker === 'incompat') void addList('incompat', packageId);
    setPicker(null);
    setFilter('');
  };

  const filtered = useMemo(() => {
    if (!filter.trim()) return candidatePool;
    const q = filter.toLowerCase();
    return candidatePool.filter(
      (m) =>
        m.about.name.toLowerCase().includes(q) ||
        m.about.packageIdLc.includes(q),
    );
  }, [candidatePool, filter]);

  return (
    <div className="flex-1 overflow-auto px-8 py-8">
      <div className="mx-auto max-w-3xl">
        <h2 className="font-display text-xl font-medium text-ink">Dependencies</h2>
        <p className="mt-1 text-sm text-muted">
          Tell RimWorld (and other mod managers) what your mod needs to load
          properly. The agent can also edit About.xml directly — these lists
          stay in sync.
        </p>

        <Section
          title="Required dependencies"
          subtitle="Hard deps. RimWorld refuses to load this mod without them."
          onAdd={() => setPicker('dep')}
          disabled={busy}
        >
          {deps.length === 0 ? (
            <Empty>No dependencies declared.</Empty>
          ) : (
            deps.map((d) => (
              <Row
                key={d.packageIdLc}
                title={d.displayName || d.packageId}
                subtitle={d.packageId}
                onRemove={() => removeDep(d.packageIdLc)}
                disabled={busy}
              />
            ))
          )}
        </Section>

        <Section
          title="Load after"
          subtitle="Soft hint: when these are active, this mod loads later in the list."
          onAdd={() => setPicker('after')}
          disabled={busy}
        >
          {loadAfter.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            loadAfter.map((pid) => (
              <Row
                key={pid}
                title={pid}
                subtitle=""
                onRemove={() => removeList('after', pid)}
                disabled={busy}
              />
            ))
          )}
        </Section>

        <Section
          title="Load before"
          subtitle="Soft hint: when these are active, this mod loads earlier."
          onAdd={() => setPicker('before')}
          disabled={busy}
        >
          {loadBefore.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            loadBefore.map((pid) => (
              <Row
                key={pid}
                title={pid}
                subtitle=""
                onRemove={() => removeList('before', pid)}
                disabled={busy}
              />
            ))
          )}
        </Section>

        <Section
          title="Incompatible with"
          subtitle="Conflicting mods. Library will flag both as ⛔ when both are active."
          onAdd={() => setPicker('incompat')}
          disabled={busy}
        >
          {incompat.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            incompat.map((pid) => (
              <Row
                key={pid}
                title={pid}
                subtitle=""
                onRemove={() => removeList('incompat', pid)}
                disabled={busy}
              />
            ))
          )}
        </Section>
      </div>

      {picker && (
        <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 p-6 pt-24">
          <div className="w-full max-w-xl rounded-lg border border-line bg-paper shadow-xl">
            <div className="border-b border-line px-4 py-3">
              <div className="font-display text-sm font-medium text-ink">
                {pickerTitle(picker)}
              </div>
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search by name or packageId…"
                className="mt-2 h-8 w-full rounded-md border border-line bg-paper px-2 text-sm"
              />
            </div>
            <div className="max-h-[50vh] divide-y divide-line overflow-auto">
              {filtered.slice(0, 200).map((m) => (
                <button
                  key={m.about.packageIdLc + m.folder}
                  onClick={() => onPick(m.about.packageId, m.about.name || m.folder)}
                  className="flex w-full items-baseline gap-3 px-4 py-2 text-left hover:bg-raised/40"
                >
                  <span className="text-sm text-ink">
                    {m.about.name || m.folder}
                  </span>
                  <span className="font-mono text-[10px] text-muted">
                    {m.about.packageId}
                  </span>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="p-6 text-center text-xs text-muted">
                  No mods match. Type a packageId and press Add manually.
                </div>
              )}
            </div>
            <div className="flex items-center justify-between border-t border-line px-4 py-2">
              <button
                onClick={() => {
                  if (filter.trim()) onPick(filter.trim(), filter.trim());
                }}
                disabled={!filter.trim()}
                className="rounded-md border border-line px-3 py-1 text-xs text-muted hover:border-ink/40 hover:text-ink disabled:opacity-50"
              >
                Add manually
              </button>
              <button
                onClick={() => {
                  setPicker(null);
                  setFilter('');
                }}
                className="rounded-md border border-line px-3 py-1 text-xs text-muted hover:border-ink/40 hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function pickerTitle(picker: 'dep' | 'after' | 'before' | 'incompat'): string {
  switch (picker) {
    case 'dep':
      return 'Add dependency';
    case 'after':
      return 'Load after which mod?';
    case 'before':
      return 'Load before which mod?';
    case 'incompat':
      return 'Mark as incompatible with…';
  }
}

function Section({
  title,
  subtitle,
  onAdd,
  disabled,
  children,
}: {
  title: string;
  subtitle: string;
  onAdd: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <div className="mb-2 flex items-baseline justify-between">
        <div>
          <h3 className="font-display text-base font-medium text-ink">{title}</h3>
          <p className="text-xs text-muted">{subtitle}</p>
        </div>
        <button
          onClick={onAdd}
          disabled={disabled}
          className="rounded-md border border-line bg-paper px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted hover:border-ink/40 hover:text-ink disabled:opacity-50"
        >
          + add
        </button>
      </div>
      <div className="rounded-lg border border-line bg-surface/30 divide-y divide-line">
        {children}
      </div>
    </section>
  );
}

function Row({
  title,
  subtitle,
  onRemove,
  disabled,
}: {
  title: string;
  subtitle: string;
  onRemove: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-ink">{title}</div>
        {subtitle && (
          <div className="truncate font-mono text-[10px] text-muted">{subtitle}</div>
        )}
      </div>
      <button
        onClick={onRemove}
        disabled={disabled}
        className={cn(
          'rounded-md border border-line bg-paper px-2 py-0.5 text-[11px] text-muted hover:border-red-500/40 hover:text-red-700',
          disabled && 'opacity-50',
        )}
      >
        Remove
      </button>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-3 text-xs text-muted">{children}</div>;
}
