import { useCallback, useEffect, useMemo, useState } from 'react';
import { sanitizeAuthorHandle } from '@/lib/identifiers';
import type { Consent, Settings } from '@/agent/settings';
import type { EnvSnapshot } from '@/agent/env-detect';
import type { ModelOption } from '@/agent/models';
import type { OAuthEvent, OAuthLink } from '@/agent/agent-host';
import type { IndexSnapshot } from '@/agent/index/main-bridge';
import type { IndexProgressEvent } from '@/agent/index/progress';
import { CheckRow, OnboardingStep, PrimaryActionButton } from './onboarding-shell';

/** Stable step ids — the array index in `STEPS` is what we render against. */
type StepId =
  | 'consent'
  | 'rimworld'
  | 'tools'
  | 'index'
  | 'ai'
  | 'author'
  | 'done';

interface StepDef {
  id: StepId;
  eyebrow: string;
}

const STEPS: StepDef[] = [
  { id: 'consent', eyebrow: 'Welcome' },
  { id: 'rimworld', eyebrow: 'Your setup' },
  { id: 'tools', eyebrow: 'Build tools' },
  { id: 'index', eyebrow: 'Index' },
  { id: 'ai', eyebrow: 'AI provider' },
  { id: 'author', eyebrow: 'Author handle' },
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
      const accepted =
        c.accepted !== null && c.accepted.version === c.required;
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
    const idx = STEPS.findIndex((s) => s.id === stepId);
    const next = STEPS[idx + 1];
    if (!next) {
      void window.modmixer.completeOnboarding().then(onComplete);
      return;
    }
    setStepId(next.id);
  }, [stepId, onComplete]);

  const goBack = useCallback(() => {
    const idx = STEPS.findIndex((s) => s.id === stepId);
    const prev = STEPS[idx - 1];
    if (!prev) return;
    if (prev.id === 'consent' && !needsConsent) {
      // Don't bounce the user back to a step they already cleared on a
      // previous run — fall through to the next-prev.
      const grandPrev = STEPS[idx - 2];
      if (grandPrev) setStepId(grandPrev.id);
      return;
    }
    setStepId(prev.id);
  }, [stepId, needsConsent]);

  const finish = useCallback(() => {
    void window.modmixer.completeOnboarding().then(onComplete);
  }, [onComplete]);

  const stepIndex = STEPS.findIndex((s) => s.id === stepId) + 1;
  const total = STEPS.length;

  if (!settings) {
    return <div className="fixed inset-0 bg-paper" />;
  }

  if (stepId === 'consent') {
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
  }

  if (stepId === 'rimworld') {
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
  }

  if (stepId === 'tools') {
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
  }

  if (stepId === 'index') {
    return (
      <IndexStep
        stepIndex={stepIndex}
        total={total}
        onContinue={goNext}
        onBack={goBack}
      />
    );
  }

  if (stepId === 'ai') {
    return (
      <AiStep
        stepIndex={stepIndex}
        total={total}
        onContinue={goNext}
        onBack={goBack}
      />
    );
  }

  if (stepId === 'author') {
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

  return null;
}

// ───────────────────────────────────────────────────────────── Consent ─────

function ConsentStep({
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const next = await window.modmixer.acceptConsent({
        analyticsOptIn: analyticsChecked,
      });
      if (next.consent) onAccepted(next.consent);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <OnboardingStep
      stepIndex={stepIndex}
      totalSteps={total}
      eyebrow="Welcome"
      title="Welcome to Modmixer"
      subtitle="Modmixer is an AI agent that builds RimWorld mods for you. It's still early — expect rough edges, occasional weirdness, and steady improvements. Thanks for trying it out."
      canContinue={!submitting}
      continueLabel={
        submitting ? 'Accepting…' : accepted ? 'Continue' : 'Accept & continue'
      }
      onContinue={() => void accept()}
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
        {error && <p className="text-sm text-failed">{error}</p>}
      </div>
    </OnboardingStep>
  );
}

// ───────────────────────────────────────────────────────────── RimWorld ─────

function RimWorldStep({
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

  const runWith = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await fn();
        await onRefresh();
      } finally {
        setBusy(false);
      }
    },
    [onRefresh],
  );

  const browseInstall = () =>
    runWith(async () => {
      await window.modmixer.browseRimWorldInstall();
    });
  const launchGame = () =>
    runWith(async () => {
      await window.modmixer.launchRimWorld();
    });
  const recheck = () =>
    void (async () => {
      setBusy(true);
      try {
        await onRefresh();
      } finally {
        setBusy(false);
      }
    })();

  // Hard reqs for the RimWorld step: install + writable mods folder. Config
  // files (ModsConfig.xml, Player.log) are warnings — they self-heal on the
  // user's first launch and we don't want to block forever on someone who
  // hasn't decided to play today.
  const canContinue =
    env !== null &&
    env.rimworld.ok &&
    env.modsDirWritable.ok;

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
                <dd className="font-mono text-xs text-ink">
                  {env.mods.workshop}
                </dd>
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

// ───────────────────────────────────────────────────────────── Tools ─────

function ToolsStep({
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

// ───────────────────────────────────────────────────────────── Index ─────

function IndexStep({
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
              {phaseLabel && (
                <p className="mt-2 text-sm text-ink">{phaseLabel}</p>
              )}
              {snapshot.rebuilding && (
                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-paper">
                  <div
                    className="h-full bg-accent transition-all"
                    style={{
                      width:
                        fraction !== null
                          ? `${Math.max(2, fraction * 100)}%`
                          : '40%',
                      animation:
                        fraction === null
                          ? 'indexIndeterminate 1.4s linear infinite'
                          : undefined,
                    }}
                  />
                </div>
              )}
              {!snapshot.rebuilding &&
                latest?.type === 'error' && (
                  <p className="mt-3 text-xs text-failed">{latest.message}</p>
                )}
              {!snapshot.rebuilding &&
                status.type === 'stale' && (
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

// ───────────────────────────────────────────────────────────── AI ─────

function AiStep({
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
  const [links, setLinks] = useState<OAuthLink[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{
    providerId: string;
    message: string;
    authUrl?: string;
  } | null>(null);
  const [prompt, setPrompt] = useState<{
    providerId: string;
    message: string;
    placeholder?: string;
    allowEmpty?: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void window.modmixer.listOAuthLinks().then(setLinks);
    void window.modmixer.listModels().then(setModels);
  }, []);

  useEffect(() => {
    refresh();
    return window.modmixer.onOAuthEvent((event: OAuthEvent) => {
      switch (event.type) {
        case 'login-start':
          setBusyId(event.providerId);
          setProgress({ providerId: event.providerId, message: 'Starting…' });
          setPrompt(null);
          setError(null);
          break;
        case 'login-progress':
          setProgress({
            providerId: event.providerId,
            message: event.message,
            authUrl: event.authInfo?.url,
          });
          break;
        case 'prompt-needed':
          setPrompt({
            providerId: event.providerId,
            message: event.message,
            placeholder: event.placeholder,
            allowEmpty: event.allowEmpty,
          });
          break;
        case 'login-success':
          setBusyId(null);
          setProgress(null);
          setPrompt(null);
          refresh();
          break;
        case 'login-error':
          setBusyId(null);
          setProgress(null);
          setPrompt(null);
          setError(event.message);
          break;
        case 'login-cancelled':
          setBusyId(null);
          setProgress(null);
          setPrompt(null);
          break;
        case 'logout':
        case 'links-changed':
          refresh();
          break;
      }
    });
  }, [refresh]);

  const hasAi = models.length > 0;

  return (
    <OnboardingStep
      stepIndex={stepIndex}
      totalSteps={total}
      eyebrow="AI provider"
      title="Connect an AI provider"
      subtitle="Sign in with your existing AI subscription. Modmixer never sees the token — your provider charges you directly."
      canContinue={hasAi}
      continueLabel="Continue"
      onContinue={onContinue}
      onBack={onBack}
      skip={
        hasAi
          ? undefined
          : {
              label: 'Skip for now',
              onClick: onContinue,
            }
      }
    >
      <div className="space-y-3">
        {error && (
          <div className="rounded-md border border-failed/40 bg-failed/5 px-3 py-2 text-xs text-failed">
            {error}
          </div>
        )}
        <div className="divide-y divide-line rounded-md border border-line">
          {links.map((link) => (
            <ProviderRow
              key={link.id}
              link={link}
              busy={busyId === link.id}
              progress={
                progress?.providerId === link.id ? progress : null
              }
              prompt={prompt?.providerId === link.id ? prompt : null}
              onSignIn={() => {
                setError(null);
                void window.modmixer.loginOAuth(link.id);
              }}
              onCancel={() => void window.modmixer.cancelOAuthLogin()}
              onSignOut={() => void window.modmixer.logoutOAuth(link.id)}
            />
          ))}
          {links.length === 0 && (
            <div className="px-3 py-3 text-xs text-muted">
              No OAuth providers registered.
            </div>
          )}
        </div>
        <p className="text-xs text-muted">
          Not sure which to pick?{' '}
          <button
            type="button"
            onClick={() =>
              void window.modmixer.openExternal(
                'https://modmixer.com/docs/choosing-a-provider',
              )
            }
            className="text-ink underline-offset-2 transition-colors hover:underline"
          >
            See the comparison
          </button>{' '}
          on modmixer.com.
        </p>
      </div>
    </OnboardingStep>
  );
}

function ProviderRow({
  link,
  busy,
  progress,
  prompt,
  onSignIn,
  onCancel,
  onSignOut,
}: {
  link: OAuthLink;
  busy: boolean;
  progress: { message: string; authUrl?: string } | null;
  prompt: {
    providerId: string;
    message: string;
    placeholder?: string;
    allowEmpty?: boolean;
  } | null;
  onSignIn: () => void;
  onCancel: () => void;
  onSignOut: () => void;
}) {
  const [code, setCode] = useState('');
  useEffect(() => {
    if (!prompt) setCode('');
  }, [prompt]);

  const submitPrompt = () => {
    if (!prompt) return;
    if (!prompt.allowEmpty && !code.trim()) return;
    void window.modmixer.provideOAuthCode(prompt.providerId, code);
  };

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink">{link.label}</div>
          <div className="truncate text-[11px] text-muted">{link.name}</div>
        </div>
        {link.linked ? (
          <>
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ready">
              linked
            </span>
            <button
              onClick={onSignOut}
              className="rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/30 hover:text-ink"
            >
              Sign out
            </button>
          </>
        ) : busy ? (
          <button
            onClick={onCancel}
            className="rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/30 hover:text-ink"
          >
            Cancel
          </button>
        ) : (
          <button
            onClick={onSignIn}
            className="rounded-md bg-accent px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft"
          >
            Sign in
          </button>
        )}
      </div>
      {busy && progress && !prompt && (
        <div className="rounded-md border border-line bg-surface/60 px-3 py-2 text-xs text-ink">
          {progress.message}
          {progress.authUrl && (
            <div className="mt-1 truncate font-mono text-[10px] text-muted">
              {progress.authUrl}
            </div>
          )}
        </div>
      )}
      {prompt && (
        <div className="space-y-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-xs text-ink">
          <div>{prompt.message}</div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitPrompt();
              }}
              placeholder={prompt.placeholder}
              className="flex-1 rounded-md border border-line bg-paper px-2 py-1 font-mono text-xs text-ink focus:border-accent focus:outline-none"
              autoFocus
            />
            <button
              onClick={submitPrompt}
              disabled={!prompt.allowEmpty && !code.trim()}
              className="rounded-md bg-accent px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
            >
              Submit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── Author ─────

function AuthorStep({
  stepIndex,
  total,
  defaultAuthor,
  onSaved,
  onBack,
}: {
  stepIndex: number;
  total: number;
  defaultAuthor: string;
  onSaved: () => void;
  onBack: () => void;
}) {
  const [author, setAuthor] = useState(defaultAuthor);
  const [saving, setSaving] = useState(false);

  const preview = useMemo(() => sanitizeAuthorHandle(author), [author]);

  const save = async () => {
    if (!preview) return;
    setSaving(true);
    try {
      await window.modmixer.setDefaultAuthor(author);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <OnboardingStep
      stepIndex={stepIndex}
      totalSteps={total}
      eyebrow="Author handle"
      title="Pick an author handle"
      subtitle="Modmixer prefixes your mods' package IDs with this handle so they don't collide with other authors' packages."
      canContinue={!!preview && !saving}
      continueLabel={saving ? 'Saving…' : 'Get started'}
      onContinue={() => void save()}
      onBack={onBack}
    >
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            Author handle
          </span>
          <input
            type="text"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            className="w-full rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-sm text-ink focus:border-accent focus:outline-none"
            placeholder="petersmith"
            autoFocus
          />
        </label>
        <p className="text-xs text-muted">
          Your mods will get package IDs like{' '}
          <code className="font-mono text-[11px] text-ink">
            {preview || 'author'}.ModName
          </code>
          . You can change this later in Settings.
        </p>
      </div>
    </OnboardingStep>
  );
}
