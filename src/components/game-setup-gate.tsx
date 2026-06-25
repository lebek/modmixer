import { type ReactNode, useEffect, useRef } from 'react';
import type { GameId } from '@/agent/games/types';
import { useGameSetup } from './use-game-setup';

/**
 * Blocks chat until the active game's code index is built. Replaces the old
 * RimWorld-only IndexProgressModal: works for any game, keyed to whatever game
 * is in use (the focused mod tab's game, or the selected game in the library).
 *
 * - fresh        → renders nothing (chat proceeds).
 * - absent/stale → auto-kicks the build and shows granular per-phase progress.
 * - building     → shows progress; disappears the moment it flips to fresh.
 * - blocked      → only when a mod is open (the user is trying to chat): shows
 *                  the reason + a link to Settings. Never nags in the library.
 *
 * The decompile is load-bearing for the agent (search/scaffold), so this is a
 * hard gate — there's no "skip" / "chat anyway".
 */
export function GameSetupGate({
  game,
  modOpen,
  onOpenSettings,
}: {
  game: GameId | null;
  modOpen: boolean;
  onOpenSettings: () => void;
}) {
  const { snapshot, latest, phaseLabel, fraction, building, rebuild } =
    useGameSetup(game);

  // Build when the index is stale (game/toolchain changed — rebuild-on-update,
  // which we surface at launch too) or absent *and* the user is entering chat.
  // We don't force a from-scratch build just for switching the library lens to
  // a game that's never been set up — that waits until they create a mod.
  const state = snapshot?.status.state ?? null;
  const shouldTrigger = state === 'stale' || (state === 'absent' && modOpen);
  const triggered = useRef<GameId | null>(null);
  useEffect(() => {
    if (!game) {
      triggered.current = null;
      return;
    }
    if (shouldTrigger && triggered.current !== game) {
      triggered.current = game;
      rebuild(false);
    }
    if (state === 'fresh') triggered.current = null;
  }, [game, state, shouldTrigger, rebuild]);

  if (!game || !snapshot) return null;
  const status = snapshot.status;
  if (status.state === 'fresh') return null;

  // Can't build (e.g. RimWorld install not detected). Only block when the user
  // is actually trying to chat.
  if (status.state === 'blocked') {
    if (!modOpen) return null;
    return (
      <Overlay>
        <h2 className="font-display text-base font-medium text-ink">
          {status.headline}
        </h2>
        {status.blockedReason && (
          <p className="mt-2 text-sm text-muted">{status.blockedReason}</p>
        )}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onOpenSettings}
            className="rounded-md border border-line px-3 py-1.5 font-mono text-xs text-ink hover:bg-surface"
          >
            Open Settings
          </button>
        </div>
      </Overlay>
    );
  }

  // Absent and not entering chat → don't block the library for a game the user
  // merely switched the lens to; let create-mod trigger the build later.
  if (status.state === 'absent' && !modOpen) return null;

  // stale | building | (absent && modOpen) → build is mandatory before chat.
  const errored = latest?.type === 'error' && !building;
  let title = phaseLabel ?? 'Setting up the code index';
  let subtitle: string | undefined = status.headline;
  if (latest?.type === 'error' && !building) {
    title = 'Setup failed';
    subtitle = latest.message;
  } else if (latest?.type === 'phase') {
    subtitle = latest.message;
  }

  return (
    <Overlay>
      <h2 className="font-display text-base font-medium text-ink">{title}</h2>
      {subtitle && <p className="mt-2 text-sm text-muted">{subtitle}</p>}
      {!errored && (
        <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-surface">
          <div
            className="h-full bg-accent transition-all"
            style={{
              width: fraction !== null ? `${Math.max(2, fraction * 100)}%` : '40%',
              animation:
                fraction === null ? 'indexIndeterminate 1.4s linear infinite' : undefined,
            }}
          />
        </div>
      )}
      {errored && (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => rebuild(true)}
            className="rounded-md border border-line px-3 py-1.5 font-mono text-xs text-ink hover:bg-surface"
          >
            Retry
          </button>
        </div>
      )}
    </Overlay>
  );
}

function Overlay({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-6">
      <div className="w-full max-w-md rounded-md border border-line bg-paper p-5 shadow-lg">
        {children}
      </div>
    </div>
  );
}
