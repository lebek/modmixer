import { useState } from 'react';
import type { GameId } from '@/agent/games/types';
import { getSelectableGames } from '@/agent/games/registry';
import { cn } from '@/lib/cn';
import { OnboardingStep } from '../onboarding-shell';

const BLURB: Record<GameId, string> = {
  rimworld:
    "Build and diagnose RimWorld mods (C# + XML). Modmixer detects your Steam install and indexes the game's source.",
  minecraft:
    'Build and test Minecraft Java mods with NeoForge 1.21.1. Modmixer provisions Java 21 and the Gradle toolchain automatically — nothing to install.',
};

export function GamePickerStep({
  stepIndex,
  total,
  initial,
  onPick,
  onBack,
}: {
  stepIndex: number;
  total: number;
  initial: GameId;
  onPick: (game: GameId) => void;
  onBack?: () => void;
}) {
  const [game, setGame] = useState<GameId>(initial);
  const games = getSelectableGames();

  return (
    <OnboardingStep
      stepIndex={stepIndex}
      totalSteps={total}
      eyebrow="Choose a game"
      title="Which game do you want to start with?"
      subtitle="Modmixer supports more than one game. Set one up now — you can add the others any time, and they’ll also set themselves up the first time you make a mod for them."
      canContinue
      continueLabel="Continue"
      onContinue={() => onPick(game)}
      onBack={onBack}
    >
      <div className="space-y-3">
        {games.map((g) => (
          <label
            key={g.id}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-md border-2 px-4 py-3 transition-colors',
              game === g.id
                ? 'border-accent bg-accent/5'
                : 'border-line bg-surface/40 hover:border-ink/30',
            )}
          >
            <input
              type="radio"
              name="onboarding-game"
              checked={game === g.id}
              onChange={() => setGame(g.id)}
              className="mt-1"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium text-ink">
                {g.displayName}
                {g.beta && (
                  <span className="rounded-sm bg-warning/15 px-1 py-0.5 text-[9px] uppercase tracking-wide text-warning">
                    beta
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted">{BLURB[g.id]}</p>
            </div>
          </label>
        ))}
      </div>
    </OnboardingStep>
  );
}
