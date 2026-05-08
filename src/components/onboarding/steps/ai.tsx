import { useCallback, useEffect, useState } from 'react';
import type {
  OAuthEvent,
  OAuthLink,
  OpenRouterConfig,
} from '@/agent/agent-host';
import type { ModelOption } from '@/agent/models';
import { OnboardingStep } from '../onboarding-shell';

interface ProgressState {
  providerId: string;
  message: string;
  authUrl?: string;
}

interface PromptState {
  providerId: string;
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
}

export function AiStep({
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
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
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
      subtitle="We recommend OpenRouter — pay-as-you-go, no subscription needed. Already have a Claude or ChatGPT plan? Use that instead."
      canContinue={hasAi}
      continueLabel="Continue"
      onContinue={onContinue}
      onBack={onBack}
      skip={hasAi ? undefined : { label: 'Skip for now', onClick: onContinue }}
    >
      <div className="space-y-5">
        {error && (
          <div className="rounded-md border border-failed/40 bg-failed/5 px-3 py-2 text-xs text-failed">
            {error}
          </div>
        )}

        <OpenRouterRecommendedCard onSaved={refresh} />

        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-line" />
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            Or use an existing AI subscription
          </span>
          <span className="h-px flex-1 bg-line" />
        </div>

        <div className="divide-y divide-line rounded-md border border-line">
          {links.map((link) => (
            <ProviderRow
              key={link.id}
              link={link}
              busy={busyId === link.id}
              progress={progress?.providerId === link.id ? progress : null}
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

function OpenRouterRecommendedCard({ onSaved }: { onSaved: () => void }) {
  const [config, setConfig] = useState<OpenRouterConfig | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.modmixer.getOpenRouterConfig().then(setConfig);
  }, []);

  const linked = !!config?.apiKeyConfigured;

  const save = async () => {
    const key = keyInput.trim();
    if (!key) return;
    setSaving(true);
    setError(null);
    try {
      const next = await window.modmixer.setOpenRouterApiKey(key);
      setConfig(next);
      setKeyInput('');
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await window.modmixer.setOpenRouterApiKey(null);
      setConfig(next);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-md border-2 border-accent/60 bg-accent/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
            ★ Recommended
          </div>
          <div className="mt-1 text-sm font-medium text-ink">OpenRouter</div>
          <p className="mt-1 max-w-[52ch] text-xs leading-relaxed text-muted">
            Pay-as-you-go, no monthly subscription. Modmixer is preconfigured
            for Moonshot Kimi K2.6 — capable, fast, and cheap. Paste your
            API key and you're ready.
          </p>
        </div>
        <span
          className={
            'shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] ' +
            (linked ? 'text-ready' : 'text-muted')
          }
        >
          {linked ? 'linked' : 'not linked'}
        </span>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          type="password"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && keyInput.trim()) void save();
          }}
          placeholder={linked ? '••••••••  (paste to replace)' : 'sk-or-v1-…'}
          className="flex-1 rounded-md border border-line bg-paper px-2 py-1 font-mono text-xs text-ink focus:border-accent focus:outline-none"
          disabled={saving}
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !keyInput.trim()}
          className="rounded-md bg-accent px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
        >
          Save
        </button>
        {linked && (
          <button
            type="button"
            onClick={() => void clear()}
            disabled={saving}
            className="rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/30 hover:text-ink disabled:opacity-40"
          >
            Remove
          </button>
        )}
      </div>

      {error && (
        <div className="mt-2 rounded-md border border-failed/40 bg-failed/5 px-2 py-1 text-[11px] text-failed">
          {error}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() =>
            void window.modmixer.openExternal('https://openrouter.ai/keys')
          }
          className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink"
        >
          Get a key →
        </button>
        <button
          type="button"
          onClick={() =>
            void window.modmixer.openExternal('https://openrouter.ai/credits')
          }
          className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink"
        >
          Add credit →
        </button>
      </div>
    </div>
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
  prompt: PromptState | null;
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
