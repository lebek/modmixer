import { Fragment, useEffect, useRef } from 'react';
import type { GameId } from '@/agent/games/types';
import { getGame } from '@/agent/games/registry';
import { useGameSetup } from '@/components/use-game-setup';
import { OnboardingStep, PrimaryActionButton } from '../onboarding-shell';

/**
 * Builds the chosen game's source index synchronously as part of onboarding, so
 * the game is fully ready before the user's first mod. Game-neutral: it reads
 * the uniform game-setup snapshot + granular progress (see useGameSetup), so it
 * works for RimWorld (defs + C# decompile) and Minecraft (auto-provisioned JDK
 * + decompile) without per-game branches. Continue unlocks only when the index
 * is fresh — except when the build is genuinely blocked (e.g. no RimWorld
 * install), where we let the user finish onboarding and fix it later.
 */
export function IndexStep({
  stepIndex,
  total,
  game,
  onContinue,
  onBack,
}: {
  stepIndex: number;
  total: number;
  game: GameId;
  onContinue: () => void;
  onBack: () => void;
}) {
  const { snapshot, latest, ready, building, blocked, phaseLabel, fraction, rebuild } =
    useGameSetup(game);
  const gameName = getGame(game).displayName;

  // Kick the build automatically when the index is absent/stale, so reaching
  // this step starts setup without an extra click. Guarded per-game.
  const triggered = useRef<GameId | null>(null);
  const state = snapshot?.status.state ?? null;
  useEffect(() => {
    if ((state === 'absent' || state === 'stale') && triggered.current !== game) {
      triggered.current = game;
      rebuild(false);
    }
    if (state === 'fresh') triggered.current = null;
  }, [game, state, rebuild]);

  const isError = latest?.type === 'error' && !building;

  return (
    <OnboardingStep
      stepIndex={stepIndex}
      totalSteps={total}
      eyebrow="Index"
      title={`Build the ${gameName} index`}
      subtitle={`The agent searches ${gameName}'s defs/data and decompiled source to ground its answers. We build a local index once — subsequent launches pick up incremental updates.`}
      canContinue={ready || blocked}
      continueLabel={ready || blocked ? 'Continue' : 'Continue when ready'}
      onContinue={onContinue}
      onBack={onBack}
    >
      <div className="rounded-md border border-line bg-surface/40 p-4">
        {!snapshot && <p className="text-sm text-muted">Loading…</p>}

        {snapshot && ready && (
          <>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ready">
              Index ready
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              {snapshot.status.facts.map((f) => (
                <Fragment key={f.label}>
                  <dt className="text-muted">{f.label}</dt>
                  <dd className="font-mono text-xs text-ink">{f.value}</dd>
                </Fragment>
              ))}
            </dl>
          </>
        )}

        {snapshot && blocked && (
          <p className="text-sm text-ink">
            {snapshot.status.blockedReason ?? snapshot.status.headline}
          </p>
        )}

        {snapshot && !ready && !blocked && (
          <>
            <div className="flex items-center justify-between">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
                {building ? 'Building' : isError ? 'Failed' : 'Preparing…'}
              </p>
              {isError && (
                <PrimaryActionButton onClick={() => rebuild(true)}>
                  Retry
                </PrimaryActionButton>
              )}
            </div>
            {phaseLabel && <p className="mt-2 text-sm text-ink">{phaseLabel}</p>}
            {building && (
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-paper">
                <div
                  className="h-full bg-accent transition-all"
                  style={{
                    width: fraction !== null ? `${Math.max(2, fraction * 100)}%` : '40%',
                    animation:
                      fraction === null
                        ? 'indexIndeterminate 1.4s linear infinite'
                        : undefined,
                  }}
                />
              </div>
            )}
            {isError && latest?.type === 'error' && (
              <p className="mt-3 text-xs text-failed">{latest.message}</p>
            )}
          </>
        )}
      </div>
    </OnboardingStep>
  );
}
