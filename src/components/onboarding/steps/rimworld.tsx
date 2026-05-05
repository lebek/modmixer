import { useState } from 'react';
import type { EnvSnapshot } from '@/agent/env-detect';
import { CheckRow, OnboardingStep, PrimaryActionButton } from '../onboarding-shell';

export function RimWorldStep({
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
  onBack?: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const runWith = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const browseInstall = () =>
    void runWith(() => window.modmixer.browseRimWorldInstall());
  const launchGame = () =>
    void runWith(() => window.modmixer.launchRimWorld());
  const recheck = () =>
    void runWith(() => Promise.resolve());

  // Hard reqs: install + writable mods folder. Config files (ModsConfig.xml,
  // Player.log) are warnings — they self-heal on the user's first launch and
  // we don't want to block forever on someone who hasn't decided to play today.
  const canContinue = env !== null && env.rimworld.ok && env.modsDirWritable.ok;

  return (
    <OnboardingStep
      stepIndex={stepIndex}
      totalSteps={total}
      eyebrow="Your setup"
      title="Your RimWorld setup"
      subtitle="We're checking your install so the agent knows where to drop new mods, read DLC defs, and watch the log."
      canContinue={canContinue}
      onContinue={onContinue}
      onBack={onBack}
    >
      {!env ? (
        <p className="text-sm text-muted">Detecting…</p>
      ) : (
        <div className="space-y-6">
          <div className="space-y-2">
            <CheckRow
              ok={env.rimworld.ok}
              label={
                env.rimworld.ok && env.rimworld.version
                  ? `RimWorld ${env.rimworld.version}`
                  : 'RimWorld install'
              }
              hint={env.rimworld.path ?? undefined}
              detail={env.rimworld.detail}
              action={
                <PrimaryActionButton onClick={browseInstall} disabled={busy}>
                  {env.rimworld.ok ? 'Change…' : 'Browse…'}
                </PrimaryActionButton>
              }
            />
            <CheckRow
              ok={env.modsConfig.ok}
              label="ModsConfig.xml"
              hint={env.modsConfig.path ?? undefined}
              detail={env.modsConfig.detail}
              action={
                env.modsConfig.ok ? null : (
                  <PrimaryActionButton onClick={launchGame} disabled={busy}>
                    Launch RimWorld
                  </PrimaryActionButton>
                )
              }
            />
            <CheckRow
              ok={env.playerLog.ok}
              label="Player.log"
              hint={env.playerLog.path ?? undefined}
              detail={env.playerLog.detail}
            />
            <CheckRow
              ok={env.modsDirWritable.ok}
              label="Mods folder writable"
              hint={env.modsDirWritable.path ?? undefined}
              detail={env.modsDirWritable.detail}
            />
          </div>

          {env.rimworld.ok && (
            <div className="rounded-md border border-line bg-surface/40 p-3.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
                  Detected on this machine
                </p>
                <p className="font-mono text-[10px] text-muted">
                  Read-only · we don't change anything
                </p>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted">DLCs</dt>
                <dd className="font-mono text-xs text-ink">
                  {env.rimworld.dlcs.length > 0
                    ? env.rimworld.dlcs.join(', ')
                    : '(none — base game only)'}
                </dd>
                <dt className="text-muted">Workshop subscriptions</dt>
                <dd className="font-mono text-xs text-ink">{env.mods.workshop}</dd>
                <dt className="text-muted">Local mods</dt>
                <dd className="font-mono text-xs text-ink">{env.mods.local}</dd>
              </dl>
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={recheck}
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
