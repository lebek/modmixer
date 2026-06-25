import { useEffect, useState, type ReactNode } from 'react';
import { GridMark } from '../grid-mark';

/**
 * Common chrome for an onboarding step: header, scrollable body, and a
 * footer with a Skip slot, a Back link, and a Continue button. Every step
 * renders into this so the spacing, header, and CTA placement stay
 * consistent across the flow.
 */
export interface OnboardingStepProps {
  stepIndex: number;
  totalSteps: number;
  /** Short label shown next to the modmixer wordmark. */
  eyebrow: string;
  title: string;
  /** One-line lede under the title. */
  subtitle?: string;
  children: ReactNode;
  /** Disabled when the step's hard requirement isn't met yet. */
  canContinue: boolean;
  continueLabel?: string;
  onContinue: () => void;
  onBack?: () => void;
  /** When set, renders a small de-emphasized "Skip" link to the left of Continue. */
  skip?: {
    label: string;
    onClick: () => void;
  };
}

export function OnboardingStep({
  stepIndex,
  totalSteps,
  eyebrow,
  title,
  subtitle,
  children,
  canContinue,
  continueLabel = 'Continue',
  onContinue,
  onBack,
  skip,
}: OnboardingStepProps) {
  const [appVersion, setAppVersion] = useState<string>('');
  useEffect(() => {
    void window.modmixer.getAppVersion().then(setAppVersion);
  }, []);
  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-paper">
      <header className="flex items-center justify-between border-b border-line px-6 py-4">
        <div className="flex items-center gap-2.5">
          <GridMark />
          <span className="font-display text-lg font-medium tracking-tight text-ink">
            modmixer
          </span>
          {appVersion && (
            <span className="ml-1 font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
              v{appVersion}
            </span>
          )}
          <span className="ml-3 font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            {eyebrow}
          </span>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          Step {stepIndex} of {totalSteps}
        </span>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col overflow-y-auto px-6 py-10 sm:px-10">
        <h1 className="font-display text-3xl font-bold uppercase tracking-[-0.02em] text-ink sm:text-4xl">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-4 max-w-[60ch] text-sm leading-relaxed text-ink">
            {subtitle}
          </p>
        )}
        <div className="mt-8">{children}</div>
      </main>

      <footer className="border-t border-line px-6 py-4">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between sm:px-4">
          <div className="flex items-center gap-4">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink"
              >
                ← Back
              </button>
            )}
          </div>
          <div className="flex items-center gap-4">
            {skip && (
              <button
                type="button"
                onClick={skip.onClick}
                className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted/70 transition-colors hover:text-ink"
              >
                {skip.label}
              </button>
            )}
            <button
              type="button"
              onClick={onContinue}
              disabled={!canContinue}
              className="rounded-md bg-accent px-5 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
            >
              {continueLabel}
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
