import type { ReactNode } from 'react';
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
  return (
    <div className="fixed inset-0 z-[100] flex flex-col bg-paper">
      <header className="flex items-center justify-between border-b border-line px-6 py-4">
        <div className="flex items-center gap-2.5">
          <GridMark />
          <span className="font-display text-lg font-medium tracking-tight text-ink">
            modmixer
          </span>
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

export function CheckRow({
  ok,
  label,
  detail,
  hint,
  action,
}: {
  ok: boolean;
  label: string;
  detail?: string | null;
  /** Short hint under the label when ok and detail is empty (e.g. a path). */
  hint?: string | null;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-line bg-surface/40 px-3.5 py-3">
      <CheckIcon ok={ok} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-ink">{label}</div>
            {hint && (
              <div className="mt-0.5 truncate font-mono text-[11px] text-muted">
                {hint}
              </div>
            )}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
        {detail && !ok && (
          <p className="mt-2 text-xs leading-relaxed text-muted">{detail}</p>
        )}
      </div>
    </div>
  );
}

function CheckIcon({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden
      className={
        'mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ' +
        (ok
          ? 'border-ready/60 bg-ready/10 text-ready'
          : 'border-warning/60 bg-warning/10 text-warning')
      }
    >
      {ok ? (
        <svg
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-2.5 w-2.5"
        >
          <path d="M2.5 6.5l2.5 2.5 4.5-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-warning" />
      )}
    </span>
  );
}

export function PrimaryActionButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-ink transition-colors hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
