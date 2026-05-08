import type { WorkspaceMod } from '../agent/workspace';
import { ModTile } from './mod-tile';
import { byUpdatedDesc } from '@/lib/sort-mods';

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
  const sorted = [...mods].sort(byUpdatedDesc);
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
          {sorted.map((m) => (
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

