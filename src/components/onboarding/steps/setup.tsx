import type { GameId } from '@/agent/games/types';
import { getGame } from '@/agent/games/registry';
import { useGameSetup } from '@/components/use-game-setup';
import { GameSetupBody } from '@/components/game-setup-body';
import { OnboardingStep } from '../onboarding-shell';

/**
 * The single game-neutral setup step: prerequisite checks (install, toolchain,
 * paths) followed by the source-index build. Renders the same <GameSetupBody>
 * the pre-chat gate uses, so onboarding and the new-mod path stay identical.
 *
 * Continue unlocks once the *required* checks pass and the index is fresh.
 * Recommended checks (ModsConfig.xml, .NET) can be deferred here — they
 * self-heal or only bite later; the new-mod gate insists on them before the
 * user actually builds a mod.
 */
export function SetupStep({
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
  onBack?: () => void;
}) {
  const view = useGameSetup(game);
  const gameName = getGame(game).displayName;

  const canContinue = view.requirementsSatisfied && (view.ready || view.blocked);

  return (
    <OnboardingStep
      stepIndex={stepIndex}
      totalSteps={total}
      eyebrow="Setup"
      title={`Set up ${gameName}`}
      subtitle={`We check your install and toolchain, then build a local index of ${gameName}'s defs/data and decompiled source so the agent can ground its answers. This runs once.`}
      canContinue={canContinue}
      continueLabel={canContinue ? 'Continue' : 'Continue when ready'}
      onContinue={onContinue}
      onBack={onBack}
    >
      <GameSetupBody
        game={game}
        view={view}
        autoBuild={{ absent: true, stale: true }}
        requirementsFilter="all"
      />
    </OnboardingStep>
  );
}
