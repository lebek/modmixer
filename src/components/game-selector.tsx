import { useState } from 'react';
import type { GameId } from '../agent/games/types';
import { getGame, getSelectableGames } from '../agent/games/registry';
import { GameIcon } from './game-icon';
import { cn } from '@/lib/cn';

/**
 * App-level game selector. Sits between the wordmark and the Home tab and
 * conditions the home/library/create surfaces — a *lens*, not a mode: switching
 * it never touches the open mod tabs, so you can keep editing mods from another
 * game while browsing this one. Backed by `settings.selectedGameId`.
 */
export function GameSelector({
  game,
  onChange,
}: {
  game: GameId;
  onChange: (game: GameId) => void;
}) {
  const [open, setOpen] = useState(false);
  const games = getSelectableGames();
  const active = getGame(game);

  // Only one game to pick from → nothing to switch; render a static label so
  // the header stays stable rather than offering a no-op menu.
  if (games.length < 2) {
    return (
      <span className="flex shrink-0 items-center gap-1.5 px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
        <GameIcon game={game} className="h-4 w-4" />
        {active.displayName}
      </span>
    );
  }

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Switch which game your Home, Library, and new mods target. Open tabs stay open."
        className="flex items-center gap-1.5 rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/40 hover:text-ink"
      >
        <GameIcon game={game} className="h-4 w-4" />
        {active.displayName}
        <span aria-hidden className="text-subtle">
          ▾
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-20 mt-1 w-56 overflow-hidden rounded-md border border-line bg-paper shadow-lg">
            {games.map((g) => (
              <button
                key={g.id}
                onClick={() => {
                  setOpen(false);
                  onChange(g.id);
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-surface',
                  g.id === game ? 'text-ink' : 'text-muted',
                )}
              >
                <GameIcon game={g.id} className="h-4 w-4" />
                <span className="flex-1">{g.displayName}</span>
                {g.beta && (
                  <span className="rounded-sm bg-warning/15 px-1 py-0.5 text-[9px] uppercase tracking-wide text-warning">
                    beta
                  </span>
                )}
                {g.id === game && (
                  <span aria-hidden className="text-accent">
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
