import { useCallback, useEffect, useState } from 'react';
import type { Consent, Settings } from '@/agent/settings';
import type { EnvSnapshot } from '@/agent/env-detect';
import { ConsentStep } from './steps/consent';
import { RimWorldStep } from './steps/rimworld';
import { ToolsStep } from './steps/tools';
import { IndexStep } from './steps/index';
import { AiStep } from './steps/ai';
import { CommunityLoreStep } from './steps/community-lore';
import { AuthorStep } from './steps/author';

/** Stable step ids — the array index in `STEPS` is what we render against. */
type StepId =
  | 'consent'
  | 'rimworld'
  | 'tools'
  | 'index'
  | 'ai'
  | 'community-lore'
  | 'author';

const STEPS: StepId[] = [
  'consent',
  'rimworld',
  'tools',
  'index',
  'ai',
  'community-lore',
  'author',
];

export function OnboardingFlow({ onComplete }: { onComplete: () => void }) {
  const [stepId, setStepId] = useState<StepId>('consent');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [consent, setConsent] = useState<Consent | null>(null);
  const [needsConsent, setNeedsConsent] = useState(true);
  const [env, setEnv] = useState<EnvSnapshot | null>(null);

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
      setConsent(c.accepted);
      const accepted = c.accepted !== null && c.accepted.version === c.required;
      setNeedsConsent(!accepted);
      // Pre-load env so the Continue button on the consent page doesn't
      // pause; the rimworld step shows its own loading state regardless.
      void window.modmixer.detectEnv().then((next) => {
        if (!cancelled) setEnv(next);
      });
      if (accepted) setStepId('rimworld');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshEnv = useCallback(async () => {
    setEnv(null);
    const next = await window.modmixer.detectEnv();
    setEnv(next);
    return next;
  }, []);

  const goNext = useCallback(() => {
    const idx = STEPS.indexOf(stepId);
    const next = STEPS[idx + 1];
    if (!next) {
      void window.modmixer.completeOnboarding().then(onComplete);
      return;
    }
    setStepId(next);
  }, [stepId, onComplete]);

  const goBack = useCallback(() => {
    const idx = STEPS.indexOf(stepId);
    const prev = STEPS[idx - 1];
    if (!prev) return;
    if (prev === 'consent' && !needsConsent) {
      // Don't bounce the user back to a step they already cleared on a
      // previous run — fall through to the next-prev.
      const grandPrev = STEPS[idx - 2];
      if (grandPrev) setStepId(grandPrev);
      return;
    }
    setStepId(prev);
  }, [stepId, needsConsent]);

  const finish = useCallback(() => {
    void window.modmixer.completeOnboarding().then(onComplete);
  }, [onComplete]);

  const stepIndex = STEPS.indexOf(stepId) + 1;
  const total = STEPS.length;

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
    case 'rimworld':
      return (
        <RimWorldStep
          stepIndex={stepIndex}
          total={total}
          env={env}
          onRefresh={refreshEnv}
          onContinue={goNext}
          onBack={needsConsent ? goBack : undefined}
        />
      );
    case 'tools':
      return (
        <ToolsStep
          stepIndex={stepIndex}
          total={total}
          env={env}
          onRefresh={refreshEnv}
          onContinue={goNext}
          onBack={goBack}
        />
      );
    case 'index':
      return (
        <IndexStep
          stepIndex={stepIndex}
          total={total}
          onContinue={goNext}
          onBack={goBack}
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
