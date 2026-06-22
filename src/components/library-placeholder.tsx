import type { GameId } from '../agent/games/types';
import { getGame } from '../agent/games/registry';

/**
 * Shown on the Library tab when the active game isn't RimWorld. The Library is
 * RimWorld's installed-mods registry + load-order manager; other games have no
 * in-app instance to manage yet, so we explain rather than vanish the tab.
 */
export function LibraryPlaceholder({ game }: { game: GameId }) {
  const name = getGame(game).displayName;
  return (
    <div className="flex-1 overflow-auto px-8 py-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6">
          <h2 className="font-display text-xl font-medium text-ink">
            {name} library
          </h2>
          <p className="text-sm text-muted">
            Installed mods and load order.
          </p>
        </div>
        <div className="rounded-lg border border-dashed border-line bg-surface/30 p-10 text-center">
          <h3 className="font-display text-base font-medium text-ink">
            Not available for {name} yet
          </h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">
            The library manages installed mods and load order for RimWorld. For{' '}
            {name}, manage your installed mods through your launcher for now —
            in-app library support is coming.
          </p>
        </div>
      </div>
    </div>
  );
}
