import type { WorkspaceMod } from '../agent/workspace';
import { ModTile } from './mod-tile';
import { byUpdatedDesc } from '@/lib/sort-mods';

export function ModsView({
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
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="font-display text-xl font-medium text-ink">
              Your mods
            </h2>
            <p className="text-sm text-muted">
              Mods you've built in Modmixer.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onImportMod}
              className="rounded-md border border-line bg-paper px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/40 hover:text-ink"
            >
              import mod
            </button>
            <button
              data-demo="new-mod"
              onClick={onNewMod}
              className="rounded-md bg-accent px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-foreground transition-colors hover:bg-accent-soft"
            >
              + new mod
            </button>
          </div>
        </div>

        {mods.length === 0 ? (
          <EmptyState onNewMod={onNewMod} onImportMod={onImportMod} />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {sorted.map((m) => (
              <ModTile
                key={m.folder}
                mod={m}
                onClick={() => onOpen(m.folder)}
              />
            ))}
          </div>
        )}

        <div className="mt-12">
          <h3 className="font-display text-lg font-medium text-ink">
            Community mods
          </h3>
          <p className="text-sm text-muted">
            Coming soon — browse and install mods shared by other Modmixer
            users.
          </p>
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  onNewMod,
  onImportMod,
}: {
  onNewMod: () => void;
  onImportMod: () => void;
}) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-surface/30 p-10 text-center">
      <h3 className="font-display text-base font-medium text-ink">
        No mods yet
      </h3>
      <p className="mt-1 text-sm text-muted">
        Start a chat with the agent and describe what you want to build, or
        import an existing mod folder.
      </p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <button
          data-demo="new-mod"
          onClick={onNewMod}
          className="rounded-md bg-accent px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-foreground transition-colors hover:bg-accent-soft"
        >
          + new mod
        </button>
        <button
          onClick={onImportMod}
          className="rounded-md border border-line bg-paper px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/40 hover:text-ink"
        >
          import mod
        </button>
      </div>
    </div>
  );
}
