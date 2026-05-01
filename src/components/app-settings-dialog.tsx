import { useEffect, useState } from 'react';
import { sanitizeAuthorHandle } from '@/lib/identifiers';
import type { OAuthEvent, OAuthLink } from '@/agent/agent-host';
import type { ThemePreference } from '@/agent/settings';
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

                    <div className="flex items-center justify-between pt-2">
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
    <div className="space-y-3">
      <p className="text-xs text-muted">
        Sign in with your existing AI subscription. modmixer never sees the
        token — your provider charges you directly.
      </p>
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
