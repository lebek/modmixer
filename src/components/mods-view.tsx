import type { WorkspaceMod } from '../agent/workspace';
import { cn } from '@/lib/cn';
import { useModPreview } from '@/lib/use-mod-preview';

export function ModsView({
  mods,
  activeOrder,
  onOpen,
  onNewMod,
  onSync,
  onUnsync,
}: {
  mods: WorkspaceMod[];
  /** Lowercased packageIds currently in <activeMods>. */
  activeOrder: string[];
  onOpen: (folder: string) => void;
  onNewMod: () => void;
  onSync: (folder: string) => void;
  onUnsync: (folder: string) => void;
}) {
  const activeSet = new Set(activeOrder);
  return (
    <div className="flex-1 overflow-auto px-8 py-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="font-display text-xl font-medium text-ink">
              Your mods
            </h2>
            <p className="text-sm text-muted">
              Mods you've built in Modmixer. Enable a mod to load it in
              RimWorld.
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
              <ModCard
                key={m.folder}
                mod={m}
                isEnabled={
                  m.about.packageId
                    ? activeSet.has(m.about.packageId.toLowerCase())
                    : false
                }
                onOpen={() => onOpen(m.folder)}
                onSync={() => onSync(m.folder)}
                onUnsync={() => onUnsync(m.folder)}
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

function ModCard({
  mod,
  isEnabled,
  onOpen,
  onSync,
  onUnsync,
}: {
  mod: WorkspaceMod;
  /** True when the mod's packageId is in RimWorld's <activeMods>. */
  isEnabled: boolean;
  onOpen: () => void;
  onSync: () => void;
  onUnsync: () => void;
}) {
  const previewUrl = useModPreview(mod.folder);
  return (
    <div className="group flex gap-3 rounded-lg border border-line bg-surface/40 p-4 transition-colors hover:border-ink/30">
      {previewUrl && (
        <div className="aspect-square h-24 w-24 shrink-0 self-start overflow-hidden rounded-md border border-line bg-surface/60">
          <img
            src={previewUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <button
          onClick={onOpen}
          className="text-left"
        >
          <div className="flex items-baseline gap-3">
            <span className="font-display text-base font-medium text-ink">
              {mod.about.name || mod.folder}
            </span>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em]',
                isEnabled
                  ? 'bg-ready/15 text-ready'
                  : 'bg-raised text-muted',
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  isEnabled ? 'bg-ready' : 'bg-pending',
                )}
              />
              {isEnabled ? 'enabled' : 'disabled'}
            </span>
          </div>
          {(mod.schematic?.shortDescription || mod.about.description) && (
            <p className="mt-2 line-clamp-3 text-sm text-muted">
              {mod.schematic?.shortDescription || mod.about.description}
            </p>
          )}
        </button>
        <div className="mt-2 flex items-center gap-2">
          {isEnabled ? (
            <button
              onClick={onUnsync}
              className="rounded-md border border-line bg-paper px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/30 hover:text-ink"
            >
              disable
            </button>
          ) : (
            <button
              onClick={onSync}
              className="rounded-md border border-accent bg-accent px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-accent-foreground transition-colors hover:bg-accent-soft"
            >
              enable
            </button>
          )}
          <button
            onClick={onOpen}
            className="rounded-md border border-line bg-paper px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/30 hover:text-ink"
          >
            open chat
          </button>
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
