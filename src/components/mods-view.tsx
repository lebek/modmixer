import type { WorkspaceMod } from '../agent/workspace';
import { ModTile } from './mod-tile';

export function ModsView({
  mods,
  onOpen,
  onNewMod,
}: {
  mods: WorkspaceMod[];
  onOpen: (folder: string) => void;
  onNewMod: () => void;
}) {
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
          <button
            onClick={onNewMod}
            className="rounded-md bg-accent px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-foreground transition-colors hover:bg-accent-soft"
          >
            + new mod
          </button>
        </div>

        {mods.length === 0 ? (
          <EmptyState onNewMod={onNewMod} />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {mods.map((m) => (
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

function EmptyState({ onNewMod }: { onNewMod: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-surface/30 p-10 text-center">
      <h3 className="font-display text-base font-medium text-ink">
        No mods yet
      </h3>
      <p className="mt-1 text-sm text-muted">
        Start a chat with the agent and describe what you want to build.
      </p>
      <button
        onClick={onNewMod}
        className="mt-4 rounded-md bg-accent px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-foreground transition-colors hover:bg-accent-soft"
      >
        + new mod
      </button>
    </div>
  );
}
