import { useCallback, useEffect, useState } from 'react';
import type { GameId, GameSetupSnapshot } from '@/agent/games/types';
import type { IndexPhase, IndexProgressEvent } from '@/agent/index/progress';

/** Game-aware phase title for the progress UI (both games share phase ids). */
export function phaseTitle(game: GameId, phase: IndexPhase): string {
  switch (phase) {
    case 'defs':
      return game === 'minecraft' ? 'Indexing Minecraft data' : 'Indexing defs';
    case 'decompile':
      return game === 'minecraft'
        ? 'Decompiling Minecraft sources'
        : 'Decompiling RimWorld assemblies';
    case 'symbols':
      return game === 'minecraft' ? 'Indexing Java symbols' : 'Indexing C# symbols';
  }
}

export interface GameSetupView {
  snapshot: GameSetupSnapshot | null;
  latest: IndexProgressEvent | null;
  /** state === 'fresh'. */
  ready: boolean;
  building: boolean;
  /** state === 'blocked' (a prerequisite is missing — e.g. no RimWorld install). */
  blocked: boolean;
  /** Title for the current phase, game-aware. Null when idle/not in a phase. */
  phaseLabel: string | null;
  /** 0..1 fraction if the current phase reports one, else null. */
  fraction: number | null;
  /** Kick a (re)build of this game's index. No-op if already building. */
  rebuild: (force?: boolean) => void;
}

/**
 * Reads a game's setup snapshot and subscribes to its granular build progress
 * over the unified game-tagged channel. Shared by the onboarding index step
 * and the pre-chat gate so both render the same per-phase progress for either
 * game. Pass `game: null` to stay inert (e.g. nothing is open to gate).
 */
export function useGameSetup(game: GameId | null): GameSetupView {
  const [snapshot, setSnapshot] = useState<GameSetupSnapshot | null>(null);
  const [latest, setLatest] = useState<IndexProgressEvent | null>(null);

  useEffect(() => {
    if (!game) {
      setSnapshot(null);
      setLatest(null);
      return;
    }
    let cancelled = false;
    const refresh = () =>
      void window.modmixer.getGameSetupSnapshot(game).then((s) => {
        if (cancelled) return;
        setSnapshot(s);
        if (s.lastProgress) setLatest(s.lastProgress);
      });
    refresh();
    const unsub = window.modmixer.onGameSetupProgress((g, evt) => {
      if (cancelled || g !== game) return;
      setLatest(evt);
      // Re-read status so the meta/facts + state (building → fresh) advance.
      void window.modmixer.getGameSetupSnapshot(game).then((s) => {
        if (!cancelled) setSnapshot(s);
      });
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [game]);

  const rebuild = useCallback(
    (force = false) => {
      if (!game) return;
      void window.modmixer.rebuildGameSetup(game, { force });
    },
    [game],
  );

  const state = snapshot?.status.state ?? null;
  const phaseLabel =
    game && latest?.type === 'phase' ? phaseTitle(game, latest.phase) : null;
  const fraction =
    latest?.type === 'phase' && typeof latest.fraction === 'number'
      ? latest.fraction
      : null;

  return {
    snapshot,
    latest,
    ready: state === 'fresh',
    building: state === 'building',
    blocked: state === 'blocked',
    phaseLabel,
    fraction,
    rebuild,
  };
}
