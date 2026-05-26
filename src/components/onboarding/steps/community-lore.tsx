import { useEffect, useState } from 'react';
import { OnboardingStep } from '../onboarding-shell';

export function CommunityLoreStep({
  stepIndex,
  total,
  onContinue,
  onBack,
}: {
  stepIndex: number;
  total: number;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void window.modmixer.getSettings().then((s) => {
      setEnabled(s.useCommunityLore);
      setLoaded(true);
    });
  }, []);

  const handleContinue = async () => {
    await window.modmixer.setCommunityLore(enabled);
    onContinue();
  };

  return (
    <OnboardingStep
      stepIndex={stepIndex}
      totalSteps={total}
      eyebrow="Community lore"
      title="Make Modmixer smarter together"
      subtitle="Modmixer collects hard-won RimWorld-modding lessons as it works. Sharing them helps every user."
      canContinue={loaded}
      continueLabel="Continue"
      onContinue={() => void handleContinue()}
      onBack={onBack}
    >
      <div className="space-y-5">
        <label className="flex cursor-pointer items-start gap-3 rounded-md border-2 border-line bg-surface/40 px-4 py-3 transition-colors hover:border-ink/30">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="mt-1"
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-ink">
              Share community lore
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Uploads your modding lesson notes (e.g. "SoundDef volume scale is
              0–100") to help other users — and pulls everyone else's lessons
              back so your agent gets smarter too. It's a two-way exchange.
            </p>
          </div>
        </label>

        <div className="rounded-md border border-line bg-paper/40 px-4 py-3 text-xs leading-relaxed text-muted">
          <p>
            Lessons are sent anonymously, tagged only with a random device id.
            You can change this any time in Settings → General.
          </p>
        </div>
      </div>
    </OnboardingStep>
  );
}
