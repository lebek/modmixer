import { useState } from 'react';
import { useAsyncAction } from '@/lib/use-async-action';
import type { Consent } from '@/agent/settings';
import { OnboardingStep } from '../onboarding-shell';

export function ConsentStep({
  stepIndex,
  total,
  accepted,
  onAccepted,
}: {
  stepIndex: number;
  total: number;
  accepted: Consent | null;
  onAccepted: (c: Consent) => void;
}) {
  const [analyticsChecked, setAnalyticsChecked] = useState(true);
  const accept = useAsyncAction(async (analyticsOptIn: boolean) => {
    const next = await window.modmixer.acceptConsent({ analyticsOptIn });
    if (next.consent) onAccepted(next.consent);
  });

  return (
    <OnboardingStep
      stepIndex={stepIndex}
      totalSteps={total}
      eyebrow="Welcome"
      title="Welcome to Modmixer"
      subtitle="Modmixer is an AI agent that builds RimWorld mods for you. It's still early — expect rough edges, occasional weirdness, and steady improvements. Thanks for trying it out."
      canContinue={!accept.busy}
      continueLabel={
        accept.busy ? 'Accepting…' : accepted ? 'Continue' : 'Accept & continue'
      }
      onContinue={() => void accept.run(analyticsChecked)}
    >
      <div className="space-y-3">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={analyticsChecked}
            onChange={(e) => setAnalyticsChecked(e.target.checked)}
            className="mt-1"
          />
          <span className="text-sm text-ink">
            Help fix crashes and improve Modmixer
            <span className="mt-0.5 block text-xs text-muted">
              Send anonymous crash reports and basic usage events so we can
              spot bugs and prioritize fixes. No prompts, model output, file
              contents, or account info are sent. Crash reports may include
              stack traces with mod folder names; local home directory paths
              are scrubbed. You can change this any time in Settings.
            </span>
          </span>
        </label>
        {accept.error && <p className="text-sm text-failed">{accept.error}</p>}
      </div>
    </OnboardingStep>
  );
}
