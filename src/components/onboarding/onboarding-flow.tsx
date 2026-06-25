import { useCallback, useEffect, useState } from 'react';
import type { Consent, Settings } from '@/agent/settings';
import type { GameId } from '@/agent/games/types';
import { getGame } from '@/agent/games/registry';
import { ConsentStep } from './steps/consent';
import { GamePickerStep } from './steps/game-picker';
import { SetupStep } from './steps/setup';
import { AiStep } from './steps/ai';
import { CommunityLoreStep } from './steps/community-lore';
import { AuthorStep } from './steps/author';

/** Stable step ids — the array index in the computed step list is what we
 *  render against. The list is game-dependent (see buildSteps). */
type StepId =
  | 'consent'
  | 'game-picker'
  | 'setup'
  | 'ai'
  | 'community-lore'
  | 'author';

/**
 * The onboarding flow after the game picker runs one game-neutral Setup step
 * (prerequisite checks + source-index build), so the game is fully ready before
 * the first mod. The same step renders for every game — RimWorld surfaces its
 * install/toolchain checks, Minecraft auto-provisions and goes straight to the
 * index — via the shared <GameSetupBody> the new-mod gate also uses.
 */
function buildSteps(game: GameId): StepId[] {
  const gameSteps = getGame(game).setupSteps as StepId[];
  return ['consent', 'game-picker', ...gameSteps, 'ai', 'community-lore', 'author'];
}

export function OnboardingFlow({ onComplete }: { onComplete: () => void }) {
  const [stepId, setStepId] = useState<StepId>('consent');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [consent, setConsent] = useState<Consent | null>(null);
  const [needsConsent, setNeedsConsent] = useState(true);
  // The game being set up — drives which steps appear. Defaults to RimWorld
  // until the user picks on the game-picker step.
  const [pickedGame, setPickedGame] = useState<GameId>('rimworld');

  // Hydrate settings + consent state once. After consent is checked we may
  // skip the consent step automatically — the user already accepted on a
  // prior launch but never finished onboarding.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [s, c] = await Promise.all([
        window.modmixer.getSettings(),
        window.modmixer.getConsentStatus(),
      ]);
      if (cancelled) return;
      setSettings(s);
      setPickedGame(s.selectedGameId);
      setConsent(c.accepted);
      const accepted = c.accepted !== null && c.accepted.version === c.required;
      setNeedsConsent(!accepted);
      if (accepted) setStepId('game-picker');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const goNext = useCallback(() => {
    const steps = buildSteps(pickedGame);
    const idx = steps.indexOf(stepId);
    const next = steps[idx + 1];
    if (!next) {
      void window.modmixer.completeOnboarding().then(onComplete);
      return;
    }
    setStepId(next);
  }, [stepId, onComplete, pickedGame]);

  const goBack = useCallback(() => {
    const steps = buildSteps(pickedGame);
    const idx = steps.indexOf(stepId);
    const prev = steps[idx - 1];
    if (!prev) return;
    if (prev === 'consent' && !needsConsent) {
      // Don't bounce the user back to a step they already cleared on a
      // previous run — fall through to the next-prev.
      const grandPrev = steps[idx - 2];
      if (grandPrev) setStepId(grandPrev);
      return;
    }
    setStepId(prev);
  }, [stepId, needsConsent, pickedGame]);

  // Picking a game recomputes the step list; advance using the NEW list so the
  // transition is immediate (state updates are async).
  const onPickGame = useCallback((game: GameId) => {
    setPickedGame(game);
    void window.modmixer.setSelectedGame(game);
    const steps = buildSteps(game);
    const idx = steps.indexOf('game-picker');
    setStepId(steps[idx + 1]);
  }, []);

  const finish = useCallback(() => {
    void window.modmixer.completeOnboarding().then(onComplete);
  }, [onComplete]);

  const steps = buildSteps(pickedGame);
  const stepIndex = steps.indexOf(stepId) + 1;
  const total = steps.length;

  if (!settings) {
    return <div className="fixed inset-0 bg-paper" />;
  }

  switch (stepId) {
    case 'consent':
      return (
        <ConsentStep
          stepIndex={stepIndex}
          total={total}
          accepted={consent}
          onAccepted={(c) => {
            setConsent(c);
            setNeedsConsent(false);
            goNext();
          }}
        />
      );
    case 'game-picker':
      return (
        <GamePickerStep
          stepIndex={stepIndex}
          total={total}
          initial={pickedGame}
          onPick={onPickGame}
          onBack={needsConsent ? goBack : undefined}
        />
      );
    case 'setup':
      return (
        <SetupStep
          stepIndex={stepIndex}
          total={total}
          game={pickedGame}
          onContinue={goNext}
          onBack={needsConsent ? goBack : undefined}
        />
      );
    case 'ai':
      return (
        <AiStep
          stepIndex={stepIndex}
          total={total}
          onContinue={goNext}
          onBack={goBack}
        />
      );
    case 'community-lore':
      return (
        <CommunityLoreStep
          stepIndex={stepIndex}
          total={total}
          onContinue={goNext}
          onBack={goBack}
        />
      );
    case 'author':
      return (
        <AuthorStep
          stepIndex={stepIndex}
          total={total}
          defaultAuthor={settings.defaultAuthor}
          onSaved={finish}
          onBack={goBack}
        />
      );
  }
}
