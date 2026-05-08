import { useEffect, useState } from 'react';
import { sanitizeAuthorHandle } from '@/lib/identifiers';
import type {
  OAuthEvent,
  OAuthLink,
  OpenRouterConfig,
} from '@/agent/agent-host';
import type { ThemePreference } from '@/agent/settings';
import type { UpdaterState } from '@/agent/updater';
import { applyTheme } from '@/lib/theme';

export type SettingsSection = 'providers' | 'general' | 'appearance' | 'index';

export function AppSettingsDialog({
  onClose,
  initialSection = 'providers',
}: {
  onClose: () => void;
  initialSection?: SettingsSection;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [author, setAuthor] = useState<string>('');
  const [analyticsOptIn, setAnalyticsOptIn] = useState<boolean>(false);
  const [theme, setTheme] = useState<ThemePreference>('dark');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.modmixer.getSettings().then((s) => {
      setAuthor(s.defaultAuthor);
      setAnalyticsOptIn(s.analyticsOptIn);
      setTheme(s.theme);
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const preview = sanitizeAuthorHandle(author);

  const save = async () => {
    setSaving(true);
    try {
      await window.modmixer.setDefaultAuthor(author);
      await window.modmixer.setAnalyticsOptIn(analyticsOptIn);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const changeTheme = async (next: ThemePreference) => {
    setTheme(next);
    applyTheme(next);
    await window.modmixer.setTheme(next);
  };

  const sectionTitle =
    section === 'providers'
      ? 'AI providers'
      : section === 'appearance'
        ? 'Appearance'
        : section === 'index'
          ? 'RimWorld index'
          : 'General';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 px-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-md border border-line bg-paper shadow-lg"
      >
        <nav className="flex w-44 shrink-0 flex-col border-r border-line bg-surface/40 p-3">
          <SectionTab
            label="AI providers"
            active={section === 'providers'}
            onClick={() => setSection('providers')}
          />
          <SectionTab
            label="Appearance"
            active={section === 'appearance'}
            onClick={() => setSection('appearance')}
          />
          <SectionTab
            label="RimWorld index"
            active={section === 'index'}
            onClick={() => setSection('index')}
          />
          <SectionTab
            label="General"
            active={section === 'general'}
            onClick={() => setSection('general')}
          />
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <h2 className="font-display text-base font-medium text-ink">
              {sectionTitle}
            </h2>
            <button
              onClick={onClose}
              aria-label="Close"
              className="font-mono text-xs text-muted transition-colors hover:text-ink"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 overflow-auto px-5 py-4">
            {section === 'providers' && <ProvidersSection />}
            {section === 'appearance' && (
              <AppearanceSection theme={theme} onChange={changeTheme} />
            )}
            {section === 'index' && <IndexSection />}
            {section === 'general' && (
              <>
                {!loaded ? (
                  <p className="text-sm text-muted">Loading…</p>
                ) : (
                  <div className="space-y-4">
                    <UpdateRow />
                    <div>
                      <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
                        Default author handle
                      </label>
                      <input
                        type="text"
                        value={author}
                        onChange={(e) => setAuthor(e.target.value)}
                        className="w-full rounded-md border border-line bg-paper px-2.5 py-1.5 font-mono text-sm text-ink focus:border-accent focus:outline-none"
                        placeholder="petersmith"
                        autoFocus
                      />
                      <p className="mt-1.5 text-xs text-muted">
                        Used as the prefix for new mods' package IDs (
                        <code className="font-mono text-[11px]">
                          {preview || 'author'}.ModName
                        </code>
                        ).
                      </p>
                    </div>

                    <div>
                      <label className="flex cursor-pointer items-start gap-2">
                        <input
                          type="checkbox"
                          checked={analyticsOptIn}
                          onChange={(e) => setAnalyticsOptIn(e.target.checked)}
                          className="mt-0.5"
                        />
                        <span className="text-sm text-ink">
                          Help fix crashes and improve Modmixer
                          <span className="mt-0.5 block text-xs text-muted">
                            Send anonymous crash reports and basic usage events
                            so we can spot bugs and prioritize fixes. No file
                            contents, prompts, mod names, or account info are
                            sent.
                          </span>
                        </span>
                      </label>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
                      <div className="flex flex-wrap items-center gap-4">
                        <button
                          type="button"
                          onClick={() =>
                            void window.modmixer.revealLoreDir({ tier: 'user' })
                          }
                          title="Reveal the folder where Modmixer stores cross-mod modding lessons learned during your sessions."
                          className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted/70 transition-colors hover:text-ink"
                        >
                          Reveal lore folder
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            await window.modmixer.resetOnboarding();
                            window.location.reload();
                          }}
                          title="Walk through the first-run setup again. Useful after switching machines or to re-verify your install."
                          className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted/70 transition-colors hover:text-ink"
                        >
                          Re-run onboarding
                        </button>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={onClose}
                          disabled={saving}
                          className="rounded-md border border-line bg-paper px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/30 hover:text-ink disabled:opacity-40"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => void save()}
                          disabled={saving || preview === ''}
                          className="rounded-md bg-accent px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {saving ? 'Saving…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function UpdateRow() {
  const [version, setVersion] = useState<string>('');
  const [state, setState] = useState<UpdaterState>({ status: 'idle' });

  useEffect(() => {
    void window.modmixer.getAppVersion().then(setVersion);
    void window.modmixer.getUpdaterState().then(setState);
    return window.modmixer.onUpdaterState(setState);
  }, []);

  const onCheck = () => {
    void window.modmixer.checkForUpdates();
  };
  const onRestart = () => {
    void window.modmixer.quitAndInstallUpdate();
  };

  const busy = state.status === 'checking' || state.status === 'available';
  const disabled =
    state.status === 'unsupported' || busy || state.status === 'downloaded';

  let message: string | null = null;
  let tone: 'muted' | 'ready' | 'failed' = 'muted';
  if (state.status === 'unsupported') {
    message =
      state.unsupportedReason === 'dev'
        ? 'Updates disabled in dev builds.'
        : 'Auto-update is not available on this platform.';
  } else if (state.status === 'checking') {
    message = 'Checking for updates…';
  } else if (state.status === 'available') {
    message = 'Update available — downloading…';
  } else if (state.status === 'not-available') {
    message = 'You are on the latest version.';
    tone = 'ready';
  } else if (state.status === 'downloaded') {
    message = state.releaseName
      ? `Update ${state.releaseName} ready — restart to install.`
      : 'Update ready — restart to install.';
    tone = 'ready';
  } else if (state.status === 'error') {
    message = `Update check failed${state.errorMessage ? `: ${state.errorMessage}` : '.'}`;
    tone = 'failed';
  }

  const toneClass =
    tone === 'ready'
      ? 'text-ready'
      : tone === 'failed'
        ? 'text-failed'
        : 'text-muted';

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface/40 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-ink">
          Modmixer{version ? ` v${version}` : ''}
        </div>
        {message && <div className={`mt-0.5 text-xs ${toneClass}`}>{message}</div>}
      </div>
      {state.status === 'downloaded' ? (
        <button
          type="button"
          onClick={onRestart}
          className="rounded-md bg-accent px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft"
        >
          Restart to update
        </button>
      ) : (
        <button
          type="button"
          onClick={onCheck}
          disabled={disabled}
          className="rounded-md border border-line bg-paper px-3 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/30 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'Checking…' : 'Check for updates'}
        </button>
      )}
    </div>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: string; hint: string }[] = [
  { value: 'dark', label: 'Dark', hint: 'Default. Easy on the eyes.' },
  { value: 'auto', label: 'Auto', hint: 'Follow the system setting.' },
  { value: 'light', label: 'Light', hint: 'Paper and ink.' },
];

function AppearanceSection({
  theme,
  onChange,
}: {
  theme: ThemePreference;
  onChange: (next: ThemePreference) => void | Promise<void>;
}) {
  return (
    <div className="space-y-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
        Theme
      </p>
      <div className="grid gap-2">
        {THEME_OPTIONS.map((opt) => {
          const active = theme === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => void onChange(opt.value)}
              className={
                'flex items-center justify-between rounded-md border px-3 py-2 text-left transition-colors ' +
                (active
                  ? 'border-accent bg-accent/10 text-ink'
                  : 'border-line bg-paper text-ink hover:border-ink/30')
              }
            >
              <div>
                <div className="text-sm font-medium">{opt.label}</div>
                <div className="text-xs text-muted">{opt.hint}</div>
              </div>
              <span
                aria-hidden
                className={
                  'inline-flex h-4 w-4 items-center justify-center rounded-full border ' +
                  (active
                    ? 'border-accent bg-accent'
                    : 'border-line bg-paper')
                }
              >
                {active && (
                  <span className="h-1.5 w-1.5 rounded-full bg-accent-foreground" />
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SectionTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        'rounded-md px-2.5 py-1.5 text-left font-mono text-[11px] uppercase tracking-[0.18em] transition-colors ' +
        (active
          ? 'bg-paper text-ink shadow-sm'
          : 'text-muted hover:bg-paper/60 hover:text-ink')
      }
    >
      {label}
    </button>
  );
}

interface PromptState {
  providerId: string;
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
}

interface ProgressState {
  providerId: string;
  message: string;
  authUrl?: string;
}

function ProvidersSection() {
  const [links, setLinks] = useState<OAuthLink[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    void window.modmixer.listOAuthLinks().then(setLinks);
  };

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
  }, []);

  const onSignIn = (providerId: string) => {
    setError(null);
    void window.modmixer.loginOAuth(providerId);
  };

  const onCancel = () => {
    void window.modmixer.cancelOAuthLogin();
  };

  const onSignOut = (providerId: string) => {
    void window.modmixer.logoutOAuth(providerId);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        We recommend OpenRouter — pay-as-you-go, no subscription needed.
        Already have a Claude or ChatGPT plan? Use that instead. Modmixer
        never sees the token — your provider charges you directly.
      </p>
      {error && (
        <div className="rounded-md border border-failed/40 bg-failed/5 px-3 py-2 text-xs text-failed">
          {error}
        </div>
      )}

      <OpenRouterSection />

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
            onSignIn={() => onSignIn(link.id)}
            onCancel={onCancel}
            onSignOut={() => onSignOut(link.id)}
          />
        ))}
        {links.length === 0 && (
          <div className="px-3 py-3 text-xs text-muted">
            No OAuth providers registered.
          </div>
        )}
      </div>
    </div>
  );
}

function OpenRouterSection() {
  const [config, setConfig] = useState<OpenRouterConfig | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [slugInput, setSlugInput] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [addingSlug, setAddingSlug] = useState(false);

  useEffect(() => {
    void window.modmixer.getOpenRouterConfig().then(setConfig);
  }, []);

  const saveKey = async () => {
    setSavingKey(true);
    try {
      const next = await window.modmixer.setOpenRouterApiKey(keyInput);
      setConfig(next);
      setKeyInput('');
    } finally {
      setSavingKey(false);
    }
  };

  const clearKey = async () => {
    setSavingKey(true);
    try {
      const next = await window.modmixer.setOpenRouterApiKey(null);
      setConfig(next);
    } finally {
      setSavingKey(false);
    }
  };

  const addSlug = async () => {
    const slug = slugInput.trim();
    if (!slug) return;
    setAddingSlug(true);
    try {
      const next = await window.modmixer.addOpenRouterModel(slug);
      setConfig(next);
      setSlugInput('');
    } finally {
      setAddingSlug(false);
    }
  };

  const removeSlug = async (slug: string) => {
    const next = await window.modmixer.removeOpenRouterModel(slug);
    setConfig(next);
  };

  if (!config) return null;

  return (
    <div className="space-y-3 rounded-md border-2 border-accent/60 bg-accent/5">
      <div className="border-b border-line px-3 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
              ★ Recommended
            </div>
            <div className="mt-1 text-sm font-medium text-ink">OpenRouter</div>
            <div className="mt-0.5 text-[11px] text-muted">
              Paste an API key — Moonshot Kimi K2.6 is preconfigured. Add more
              slugs below if you want.
            </div>
          </div>
          <span
            className={
              'shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] ' +
              (config.apiKeyConfigured ? 'text-ready' : 'text-muted')
            }
          >
            {config.apiKeyConfigured ? 'linked' : 'not linked'}
          </span>
        </div>
      </div>

      <div className="space-y-2 px-3 pb-2">
        <label className="block font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          API key
        </label>
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && keyInput.trim()) void saveKey();
            }}
            placeholder={
              config.apiKeyConfigured
                ? '••••••••  (paste to replace)'
                : 'sk-or-v1-…'
            }
            className="flex-1 rounded-md border border-line bg-paper px-2 py-1 font-mono text-xs text-ink focus:border-accent focus:outline-none"
          />
          <button
            onClick={() => void saveKey()}
            disabled={savingKey || !keyInput.trim()}
            className="rounded-md bg-accent px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
          >
            Save
          </button>
          {config.apiKeyConfigured && (
            <button
              onClick={() => void clearKey()}
              disabled={savingKey}
              className="rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/30 hover:text-ink disabled:opacity-40"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      <div className="space-y-2 border-t border-line px-3 py-3">
        <label className="block font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          Models
        </label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={slugInput}
            onChange={(e) => setSlugInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && slugInput.trim()) void addSlug();
            }}
            placeholder="anthropic/claude-sonnet-4.5"
            className="flex-1 rounded-md border border-line bg-paper px-2 py-1 font-mono text-xs text-ink focus:border-accent focus:outline-none"
          />
          <button
            onClick={() => void addSlug()}
            disabled={addingSlug || !slugInput.trim()}
            className="rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/30 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add
          </button>
        </div>
        {config.models.length === 0 ? (
          <p className="text-[11px] text-muted">
            No models saved. Find slugs at{' '}
            <button
              type="button"
              onClick={() =>
                void window.modmixer.openExternal('https://openrouter.ai/models')
              }
              className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted/80 underline-offset-2 hover:text-ink hover:underline"
            >
              openrouter.ai/models
            </button>
            .
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {config.models.map((slug) => {
              const pinned = config.pinnedModels.includes(slug);
              return (
                <li
                  key={slug}
                  className="flex items-center justify-between px-2.5 py-1.5"
                >
                  <span className="font-mono text-xs text-ink">{slug}</span>
                  {pinned ? (
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ready">
                      ★ Recommended
                    </span>
                  ) : (
                    <button
                      onClick={() => void removeSlug(slug)}
                      className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-failed"
                    >
                      Remove
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
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
  progress: ProgressState | null;
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
        <StatusPill link={link} />
        {link.linked ? (
          <button
            onClick={onSignOut}
            className="rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/30 hover:text-ink"
          >
            Sign out
          </button>
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

function IndexSection() {
  const [snapshot, setSnapshot] = useState<
    Awaited<ReturnType<typeof window.modmixer.getIndexSnapshot>> | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    void window.modmixer.getIndexSnapshot().then((s) => {
      if (!cancelled) setSnapshot(s);
    });
    const unsub = window.modmixer.onIndexProgress(() => {
      void window.modmixer.getIndexSnapshot().then((s) => {
        if (!cancelled) setSnapshot(s);
      });
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  if (!snapshot) {
    return <p className="text-sm text-muted">Loading…</p>;
  }

  const { status, rebuilding } = snapshot;
  const meta = 'meta' in status ? status.meta : null;

  const startRebuild = () => {
    void window.modmixer.rebuildIndex({ force: true });
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        The RimWorld index powers the agent's def lookups and C# source
        search. It's built from your local install on first launch and
        rebuilt automatically when RimWorld updates.
      </p>

      <div className="rounded-md border border-line bg-surface/40 p-3">
        <div className="flex items-center justify-between">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            Status
          </h3>
          <StatusBadge status={status.type} rebuilding={rebuilding} />
        </div>
        {status.type === 'no-rimworld' && (
          <p className="mt-2 text-sm text-ink">
            RimWorld install not detected — the index can't be built. Make
            sure RimWorld is installed via Steam, then return here.
          </p>
        )}
        {status.type === 'absent' && (
          <p className="mt-2 text-sm text-ink">
            No index yet. Click <strong>Rebuild</strong> below to build it
            (~30-90s on first run).
          </p>
        )}
        {status.type === 'stale' && (
          <p className="mt-2 text-sm text-ink">
            Index is out of date — {status.reason}. Rebuild to refresh.
          </p>
        )}
        {status.type === 'fresh' && meta && (
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-ink">
            <dt className="text-muted">RimWorld</dt>
            <dd className="font-mono text-xs">{meta.rimworldVersion}</dd>
            <dt className="text-muted">DLC packs</dt>
            <dd className="font-mono text-xs">
              {meta.dlcs.length > 0 ? meta.dlcs.join(', ') : '(none)'}
            </dd>
            <dt className="text-muted">Defs</dt>
            <dd className="font-mono text-xs">{meta.defCount.toLocaleString()}</dd>
            <dt className="text-muted">C# symbols</dt>
            <dd className="font-mono text-xs">
              {meta.symbolCount.toLocaleString()}
            </dd>
            <dt className="text-muted">Source size</dt>
            <dd className="font-mono text-xs">{formatBytes(meta.sourceBytes)}</dd>
            <dt className="text-muted">Built</dt>
            <dd className="font-mono text-xs">
              {new Date(meta.builtAt).toLocaleString()}
            </dd>
          </dl>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={startRebuild}
          disabled={rebuilding || status.type === 'no-rimworld'}
          className="rounded-md bg-accent px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
        >
          {rebuilding ? 'Building…' : 'Rebuild'}
        </button>
      </div>
    </div>
  );
}

function StatusBadge({
  status,
  rebuilding,
}: {
  status: 'fresh' | 'stale' | 'absent' | 'no-rimworld' | 'building';
  rebuilding: boolean;
}) {
  if (rebuilding) {
    return (
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
        building
      </span>
    );
  }
  const tone =
    status === 'fresh'
      ? 'text-ready'
      : status === 'no-rimworld'
        ? 'text-muted'
        : 'text-warning';
  return (
    <span className={`font-mono text-[10px] uppercase tracking-[0.18em] ${tone}`}>
      {status}
    </span>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function StatusPill({ link }: { link: OAuthLink }) {
  if (link.linked) {
    return (
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ready">
        linked
      </span>
    );
  }
  if (link.source === 'environment') {
    return (
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
        env
      </span>
    );
  }
  return null;
}
