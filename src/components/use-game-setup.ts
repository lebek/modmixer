import { useCallback, useEffect, useState } from 'react';
import type {
  GameId,
  GameSetupSnapshot,
  SetupRequirements,
} from '@/agent/games/types';
import { getGame } from '@/agent/games/registry';
import type { IndexPhase, IndexProgressEvent } from '@/agent/index/progress';

/** Per-game phase title for the progress UI (both games share phase ids). */
export function phaseTitle(game: GameId, phase: IndexPhase): string {
  return getGame(game).indexPhaseLabels[phase];
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
  /** Prerequisite checks (null until first probe completes). */
  requirements: SetupRequirements | null;
  /** Every `required` check is ok — the index build may proceed. */
  requirementsSatisfied: boolean;
  /** Re-run the prerequisite probe (after the user applies a fix). */
  recheckRequirements: () => Promise<void>;
  /**
   * The pre-chat gate has nothing blocking to show: every *required* check is
   * green and the index is fresh. Recommended checks (ModsConfig.xml, .NET) are
   * deferred — they don't gate chat, only the test loop that actually needs
   * them. The new-mod gate renders nothing in this state.
   */
  allClear: boolean;
}

/**
 * Reads a game's setup snapshot and subscribes to its granular build progress
 * over the unified game-tagged channel. Shared by the onboarding Setup step and
 * the pre-chat gate so both render the same prerequisite checks + per-phase
 * progress for either game. Pass `game: null` to stay inert (e.g. nothing is
 * open to gate).
 *
 * `probeRequirements` controls the expensive prerequisite probe (it spawns
 * toolchain checks and touches the Mods dir). Onboarding leaves it on; the
 * always-mounted gate passes `modOpen` so a plain library lens-switch doesn't
 * run it.
 */
export function useGameSetup(
  game: GameId | null,
  probeRequirements = true,
): GameSetupView {
  const [snapshot, setSnapshot] = useState<GameSetupSnapshot | null>(null);
  const [latest, setLatest] = useState<IndexProgressEvent | null>(null);
  const [requirements, setRequirements] = useState<SetupRequirements | null>(
    null,
  );

  // Probe prerequisites on mount + on demand only (not on every progress tick):
  // it's the expensive fs/exec check and it doesn't change mid-build.
  useEffect(() => {
    if (!game || !probeRequirements) {
      setRequirements(null);
      return;
    }
    let cancelled = false;
    void window.modmixer.checkGameRequirements(game).then((r) => {
      if (!cancelled) setRequirements(r);
    });
    return () => {
      cancelled = true;
    };
  }, [game, probeRequirements]);

  const recheckRequirements = useCallback(async () => {
    if (!game) return;
    const r = await window.modmixer.checkGameRequirements(game);
    setRequirements(r);
  }, [game]);

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

  const ready = state === 'fresh';
  // Until the probe lands, treat requirements as unsatisfied so we never
  // auto-kick a build or flash "all clear" before we actually know.
  const requirementsSatisfied = requirements?.satisfied ?? false;
  // The pre-chat gate blocks on this. Gate on REQUIRED checks only — a missing
  // recommended prerequisite (e.g. ModsConfig.xml, which RimWorld writes on
  // first launch) must not wall an existing user out of chat the way counting
  // `allOk` did. Recommended rows still surface in onboarding + Settings →
  // Games, and run_test_cycle re-checks the test-time ones (ModsConfig, writable
  // Mods) before it actually needs them.
  const allClear = requirementsSatisfied && ready;

  return {
    snapshot,
    latest,
    ready,
    building: state === 'building',
    blocked: state === 'blocked',
    phaseLabel,
    fraction,
    rebuild,
    requirements,
    requirementsSatisfied,
    recheckRequirements,
    allClear,
  };
}
