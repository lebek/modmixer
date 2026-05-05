import { useEffect, useState } from 'react';
import type { IndexSnapshot } from '@/agent/index/main-bridge';
import type { IndexProgressEvent } from '@/agent/index/progress';
import { OnboardingStep, PrimaryActionButton } from '../onboarding-shell';

export function IndexStep({
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
  const [snapshot, setSnapshot] = useState<IndexSnapshot | null>(null);
  const [latest, setLatest] = useState<IndexProgressEvent | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.modmixer.getIndexSnapshot().then((s) => {
      if (cancelled) return;
      setSnapshot(s);
      if (s.lastProgress) setLatest(s.lastProgress);
    });
    const unsub = window.modmixer.onIndexProgress((evt) => {
      if (cancelled) return;
      setLatest(evt);
      void window.modmixer.getIndexSnapshot().then((s) => {
        if (!cancelled) setSnapshot(s);
      });
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const startBuild = () => {
    void window.modmixer.rebuildIndex({ force: false });
  };

  if (!snapshot) {
    return (
      <OnboardingStep
        stepIndex={stepIndex}
        totalSteps={total}
        eyebrow="Index"
        title="Build the RimWorld index"
        canContinue={false}
        onContinue={onContinue}
        onBack={onBack}
      >
        <p className="text-sm text-muted">Loading…</p>
      </OnboardingStep>
    );
  }

  const status = snapshot.status;
  const ready = status.type === 'fresh';
  const noRimworld = status.type === 'no-rimworld';
  const fraction =
    latest?.type === 'phase' && typeof latest.fraction === 'number'
      ? latest.fraction
      : null;
  const phaseLabel =
    latest?.type === 'phase'
      ? latest.phase === 'defs'
        ? 'Indexing defs'
        : latest.phase === 'decompile'
          ? 'Decompiling RimWorld assemblies'
          : 'Indexing C# symbols'
      : null;

  return (
    <OnboardingStep
      stepIndex={stepIndex}
      totalSteps={total}
      eyebrow="Index"
      title="Build the RimWorld index"
      subtitle="The agent searches RimWorld's defs and decompiled C# to ground its answers. We build a local index once — subsequent launches pick up incremental updates."
      canContinue={ready || noRimworld}
      continueLabel={ready ? 'Continue' : 'Continue when ready'}
      onContinue={onContinue}
      onBack={onBack}
    >
      <div className="space-y-4">
        <div className="rounded-md border border-line bg-surface/40 p-4">
          {ready && status.type === 'fresh' && (
            <>
              <div className="flex items-center justify-between">
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ready">
                  Index ready
                </p>
                <p className="font-mono text-[10px] text-muted">
                  Built{' '}
                  {new Date(status.meta.builtAt).toLocaleString(undefined, {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted">RimWorld</dt>
                <dd className="font-mono text-xs text-ink">
                  {status.meta.rimworldVersion}
                </dd>
                <dt className="text-muted">DLC packs</dt>
                <dd className="font-mono text-xs text-ink">
                  {status.meta.dlcs.length > 0
                    ? status.meta.dlcs.join(', ')
                    : '(none)'}
                </dd>
                <dt className="text-muted">Defs indexed</dt>
                <dd className="font-mono text-xs text-ink">
                  {status.meta.defCount.toLocaleString()}
                </dd>
                <dt className="text-muted">C# symbols</dt>
                <dd className="font-mono text-xs text-ink">
                  {status.meta.symbolCount.toLocaleString()}
                </dd>
              </dl>
            </>
          )}
          {!ready && !noRimworld && (
            <>
              <div className="flex items-center justify-between">
                <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
                  {snapshot.rebuilding ? 'Building' : 'Ready to build'}
                </p>
                {!snapshot.rebuilding && (
                  <PrimaryActionButton onClick={startBuild}>
                    Build now
                  </PrimaryActionButton>
                )}
              </div>
              {phaseLabel && <p className="mt-2 text-sm text-ink">{phaseLabel}</p>}
              {snapshot.rebuilding && (
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-paper">
                  <div
                    className="h-full bg-accent transition-all"
                    style={{
                      width:
                        fraction !== null ? `${Math.max(2, fraction * 100)}%` : '40%',
                      animation:
                        fraction === null
                          ? 'indexIndeterminate 1.4s linear infinite'
                          : undefined,
                    }}
                  />
                </div>
              )}
              {!snapshot.rebuilding && latest?.type === 'error' && (
                <p className="mt-3 text-xs text-failed">{latest.message}</p>
              )}
              {!snapshot.rebuilding && status.type === 'stale' && (
                <p className="mt-3 text-xs text-muted">
                  {status.reason} — click <strong>Build now</strong> to refresh.
                </p>
              )}
            </>
          )}
          {noRimworld && (
            <p className="text-sm text-ink">
              RimWorld install not detected. Skipping the index for now — you
              can build it later from Settings → RimWorld index.
            </p>
          )}
        </div>
      </div>
    </OnboardingStep>
  );
}
