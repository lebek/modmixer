import { type ReactNode } from 'react';
import type { GameId } from '@/agent/games/types';
import { getGame } from '@/agent/games/registry';
import { useGameSetup } from './use-game-setup';
import { GameSetupBody } from './game-setup-body';

/**
 * Blocks chat until the active game is fully set up — every *required*
 * prerequisite check is green AND the code index is fresh. Recommended checks
 * (ModsConfig.xml, .NET) are deferred so they never wall a working user out of
 * chat; the test loop re-checks the ones it needs. Shares its entire body (the
 * requirement checks + the index build/progress) with onboarding's Setup step
 * via <GameSetupBody>, so the two paths stay identical and we make them robust
 * once.
 *
 * - allClear (required checks ok + index fresh) → renders nothing; chat proceeds.
 * - not modOpen (just the library lens on a game) → never nags; renders nothing.
 * - otherwise → a blocking overlay showing the unmet checks + index progress.
 *
 * The decompile is load-bearing for the agent (search/scaffold) and the checks
 * gate a working test loop, so this is a hard gate on *chatting* with this mod —
 * there's no "chat anyway". It is not a trap, though: the gate already contains
 * the full setup UI (checks + their fix actions + index build), so the only
 * other affordance it needs is a way *out* — `onExit` steps back to Home so a
 * user who isn't ready to set this game up isn't walled into a dead end.
 */
export function GameSetupGate({
  game,
  modOpen,
  onExit,
}: {
  game: GameId | null;
  modOpen: boolean;
  /** Leave the gate (back to Home) without finishing setup. */
  onExit: () => void;
}) {
  // Only probe prerequisites when a mod is actually open (the gate is mounted
  // app-wide; we don't want the toolchain probe firing on every lens-switch).
  const view = useGameSetup(game, modOpen);

  // Nothing to do, or the user isn't trying to chat — stay out of the way.
  if (!game || view.allClear || !modOpen) return null;
  // Wait for the first probe so we don't flash an overlay before we know state.
  if (!view.requirements || !view.snapshot) return null;

  const gameName = getGame(game).displayName;

  return (
    <Overlay>
      <h2 className="font-display text-base font-medium text-ink">
        Finish setting up {gameName}
      </h2>
      <p className="mt-1 text-sm text-muted">
        Modmixer needs this ready before you can build and test this mod.
      </p>
      <div className="mt-4">
        <GameSetupBody
          game={game}
          view={view}
          autoBuild={{ absent: modOpen, stale: true }}
          requirementsFilter="unmet"
        />
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onExit}
          className="rounded-md border border-line px-3 py-1.5 font-mono text-xs text-ink hover:bg-surface"
        >
          Back to Home
        </button>
      </div>
    </Overlay>
  );
}

function Overlay({ children }: { children: ReactNode }) {
  return (
    // z-40, one tier below the z-50 interactive dialogs (Settings, confirms,
    // session recovery): this is a passive wall, so any dialog the user
    // explicitly opens must render *above* it rather than be trapped behind it.
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 px-6">
      <div className="w-full max-w-md rounded-md border border-line bg-paper p-5 shadow-lg">
        {children}
      </div>
    </div>
  );
}
