import type { WorkspaceMod } from '../agent/workspace';
import { cn } from '@/lib/cn';

export function BuildLanding({
  mods,
  onOpen,
  onNewMod,
  onImportMod,
}: {
  mods: WorkspaceMod[];
  onOpen: (folder: string) => void;
  onNewMod: () => void;
  onImportMod: () => void;
}) {
  return (
    <div className="flex-1 overflow-auto px-8 py-8">
      <div className="mx-auto max-w-4xl">
        <div className="mb-6">
          <h2 className="font-display text-xl font-medium text-ink">Build</h2>
          <p className="text-sm text-muted">
            Pick a mod to keep working on, scaffold a new one, or import an
            existing folder.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <NewModTile onClick={onNewMod} />
          <ImportModTile onClick={onImportMod} />
          {mods.map((m) => (
            <ModTile key={m.folder} mod={m} onClick={() => onOpen(m.folder)} />
          ))}
        </div>

        <div className="mt-12">
          <h3 className="font-display text-lg font-medium text-ink">
            Templates
          </h3>
          <p className="text-sm text-muted">
            Coming soon — start from a curated mod template (Harmony patch,
            new Def pack, ambient audio, etc.).
          </p>
        </div>
      </div>
    </div>
  );
}

function NewModTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-start justify-between gap-3 rounded-lg border border-dashed border-line bg-surface/30 p-4 text-left transition-colors hover:border-accent/60 hover:bg-accent/5"
    >
      <div>
        <div className="font-display text-base font-medium text-ink">
          + New mod
        </div>
        <p className="mt-1 text-sm text-muted">
          Describe what you want to build and the agent will scaffold it.
        </p>
      </div>
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
        start →
      </span>
    </button>
  );
}

function ImportModTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-start justify-between gap-3 rounded-lg border border-dashed border-line bg-surface/30 p-4 text-left transition-colors hover:border-accent/60 hover:bg-accent/5"
    >
      <div>
        <div className="font-display text-base font-medium text-ink">
          ↘ Import mod
        </div>
        <p className="mt-1 text-sm text-muted">
          Pick a folder on disk to copy into the workspace and edit here.
        </p>
      </div>
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
        pick folder →
      </span>
    </button>
  );
}

function ModTile({
  mod,
  onClick,
}: {
  mod: WorkspaceMod;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col gap-2 rounded-lg border border-line bg-surface/40 p-4 text-left transition-colors hover:border-ink/30"
    >
      <div className="flex items-baseline gap-3">
        <span className="truncate font-display text-base font-medium text-ink">
          {mod.about.name || mod.folder}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em]',
            mod.active ? 'bg-ready/15 text-ready' : 'bg-raised text-muted',
          )}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              mod.active ? 'bg-ready' : 'bg-pending',
            )}
          />
          {mod.active ? 'active' : 'idle'}
        </span>
      </div>
      {(mod.schematic?.shortDescription || mod.about.description) && (
        <p className="line-clamp-2 text-sm text-muted">
          {mod.schematic?.shortDescription || mod.about.description}
        </p>
      )}
      <div className="mt-1 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
        {mod.hasCSharp && <span>C#</span>}
        {mod.hasDlls && <span>has dll</span>}
        {mod.about.supportedVersions.length > 0 && (
          <span>v={mod.about.supportedVersions.join(',')}</span>
        )}
      </div>
    </button>
  );
}
