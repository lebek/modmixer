import { useState } from 'react';
import type { WorkspaceMod } from '../agent/workspace';
import type { GameId } from '../agent/games/types';
import { ModTile } from './mod-tile';
import { byUpdatedDesc } from '@/lib/sort-mods';

export function ModsView({
  mods,
  onOpen,
  onNewMod,
  onImportMod,
  onLaunchLiveSession,
  minecraftEnabled = false,
}: {
  mods: WorkspaceMod[];
  onOpen: (folder: string) => void;
  onNewMod: (game?: GameId) => void;
  onImportMod: () => void;
  onLaunchLiveSession: () => Promise<void>;
  minecraftEnabled?: boolean;
}) {
  const sorted = [...mods].sort(byUpdatedDesc);
  // Launching quits/starts RimWorld in the main process and takes several
  // seconds — keep the button disabled with a busy label until it settles
  // (errors are surfaced by the handler itself).
  const [launching, setLaunching] = useState(false);
  const launchLive = async () => {
    setLaunching(true);
    try {
      await onLaunchLiveSession();
    } finally {
      setLaunching(false);
    }
  };
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
              onClick={() => void launchLive()}
              disabled={launching}
              title="Start RimWorld in a sandboxed test colony and prompt Modmixer from inside the game. Experimental."
              className="rounded-md border border-line bg-paper px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/40 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              {launching ? (
                'launching…'
              ) : (
                <>
                  launch live session{' '}
                  <span className="ml-1 rounded-sm bg-warning/15 px-1 py-0.5 text-[9px] text-warning">
                    experimental
                  </span>
                </>
              )}
            </button>
            <button
              onClick={onImportMod}
              className="rounded-md border border-line bg-paper px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/40 hover:text-ink"
            >
              import mod
            </button>
            <NewModButton onNewMod={onNewMod} minecraftEnabled={minecraftEnabled} />
          </div>
        </div>

        {mods.length === 0 ? (
          <EmptyState
            onNewMod={onNewMod}
            onImportMod={onImportMod}
            minecraftEnabled={minecraftEnabled}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {sorted.map((m) => (
              <ModTile
                key={m.folder}
                mod={m}
                onClick={() => onOpen(m.folder)}
                showGameBadge={minecraftEnabled}
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

/**
 * "+ new mod" — a plain button for a single game, or a small game-picker menu
 * when Minecraft is enabled so the user chooses which game the mod targets
 * (each mod is for exactly one game).
 */
function NewModButton({
  onNewMod,
  minecraftEnabled,
}: {
  onNewMod: (game?: GameId) => void;
  minecraftEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnClass =
    'rounded-md bg-accent px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-foreground transition-colors hover:bg-accent-soft';
  if (!minecraftEnabled) {
    return (
      <button data-demo="new-mod" onClick={() => onNewMod()} className={btnClass}>
        + new mod
      </button>
    );
  }
  const pick = (game: GameId) => {
    setOpen(false);
    onNewMod(game);
  };
  return (
    <div className="relative">
      <button
        data-demo="new-mod"
        onClick={() => setOpen((v) => !v)}
        className={btnClass}
      >
        + new mod ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-md border border-line bg-paper shadow-lg">
            <button
              onClick={() => pick('rimworld')}
              className="block w-full px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-surface"
            >
              RimWorld mod
            </button>
            <button
              onClick={() => pick('minecraft')}
              className="block w-full px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-surface"
            >
              Minecraft mod
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function EmptyState({
  onNewMod,
  onImportMod,
  minecraftEnabled = false,
}: {
  onNewMod: (game?: GameId) => void;
  onImportMod: () => void;
  minecraftEnabled?: boolean;
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
        <NewModButton onNewMod={onNewMod} minecraftEnabled={minecraftEnabled} />
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
