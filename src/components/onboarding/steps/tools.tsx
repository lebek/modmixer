import { useState } from 'react';
import type { EnvSnapshot } from '@/agent/env-detect';
import { CheckRow, OnboardingStep, PrimaryActionButton } from '../onboarding-shell';

export function ToolsStep({
  stepIndex,
  total,
  env,
  onRefresh,
  onContinue,
  onBack,
}: {
  stepIndex: number;
  total: number;
  env: EnvSnapshot | null;
  onRefresh: () => Promise<EnvSnapshot>;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const recheck = async () => {
    setBusy(true);
    try {
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  // .NET is required for C# mod builds but the agent can still author XML
  // mods without it. Allow skipping; ilspycmd is also vendored in prod
  // builds so a missing one in dev is just informational.
  const canContinue = env !== null;
  const dotnetMissing = env !== null && !env.dotnet.ok;

  return (
    <OnboardingStep
      stepIndex={stepIndex}
      totalSteps={total}
      eyebrow="Build tools"
      title="Build tools"
      subtitle="The .NET SDK lets the agent compile C# mods. If you only plan to write XML-only mods you can skip — but the agent will tell you again the first time it tries to build."
      canContinue={canContinue}
      continueLabel={dotnetMissing ? 'Continue without .NET' : 'Continue'}
      onContinue={onContinue}
      onBack={onBack}
    >
      {!env ? (
        <p className="text-sm text-muted">Detecting…</p>
      ) : (
        <div className="space-y-3">
          <CheckRow
            ok={env.dotnet.ok}
            label=".NET SDK"
            hint={env.dotnet.path ?? undefined}
            detail={env.dotnet.detail}
            action={
              env.dotnet.ok ? null : (
                <PrimaryActionButton
                  onClick={() =>
                    void window.modmixer.openExternal(
                      'https://dotnet.microsoft.com/download',
                    )
                  }
                >
                  Install
                </PrimaryActionButton>
              )
            }
          />
          <CheckRow
            ok={env.ilspycmd.ok}
            label="ilspycmd (decompiler)"
            hint={env.ilspycmd.path ?? undefined}
            detail={env.ilspycmd.detail}
          />
          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={() => void recheck()}
              disabled={busy}
              className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink disabled:opacity-40"
            >
              {busy ? 'Re-checking…' : 'Re-check'}
            </button>
          </div>
        </div>
      )}
    </OnboardingStep>
  );
}
