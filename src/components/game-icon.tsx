import type { GameId } from '../agent/games/types';
import { getGame } from '../agent/games/registry';
import { GAME_ICONS } from './game-icons.generated';
import { cn } from '@/lib/cn';

/**
 * Small square game icon (grass block for Minecraft, sheriff star for
 * RimWorld). Source art is a 64x64 transparent PNG embedded as a data URI
 * (see scripts/build-game-icons.mjs), rendered object-contain so the differing
 * logo aspects sit centred in a fixed square box. Sizes are Tailwind h/w pairs
 * to line up with the mono text they sit beside.
 */
export function GameIcon({
  game,
  className,
}: {
  game: GameId;
  /** Tailwind sizing/spacing — defaults to a 16px square (h-4 w-4). */
  className?: string;
}) {
  return (
    <img
      src={GAME_ICONS[game]}
      alt=""
      aria-hidden
      draggable={false}
      title={getGame(game).displayName}
      className={cn('shrink-0 object-contain', className ?? 'h-4 w-4')}
    />
  );
}
