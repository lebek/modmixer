import { useEffect, useState } from 'react';
import type { ThinkingLevel } from '@mariozechner/pi-agent-core';
import { sanitizeAuthorHandle } from '@/lib/identifiers';
import type {
  OAuthEvent,
  OAuthLink,
  OpenRouterConfig,
} from '@/agent/agent-host';
import type {
  LocalProvider,
  ModelSelection,
  ThemePreference,
} from '@/agent/settings';
import type { ModelOption } from '@/agent/models';
import type { UpdaterState } from '@/agent/updater';
import { applyTheme } from '@/lib/theme';
import { ModelPicker } from './model-picker';
import { ThinkingPicker } from './thinking-picker';
import { GameIcon } from './game-icon';
import { useGameSetup } from './use-game-setup';
import { GameSetupBody } from './game-setup-body';
import { getSelectableGames } from '@/agent/games/registry';
import type { GameDefinition, GameSetupState } from '@/agent/games/types';

export type SettingsSection =
  | 'general'
  | 'providers'
  | 'games'
  | 'appearance'
  | 'advanced';

export function AppSettingsDialog({
  onClose,
  initialSection = 'general',
}: {
  onClose: () => void;
  initialSection?: SettingsSection;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [author, setAuthor] = useState<string>('');
  const [analyticsOptIn, setAnalyticsOptIn] = useState<boolean>(false);
  const [theme, setTheme] = useState<ThemePreference>('dark');
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState<ModelSelection | null>(null);
  const [defaultThinking, setDefaultThinking] =
    useState<ThinkingLevel>('medium');
  const [multiChat, setMultiChat] = useState(false);
  const [communityLore, setCommunityLore] = useState(false);
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.modmixer.getSettings().then((s) => {
      setAuthor(s.defaultAuthor);
      setAnalyticsOptIn(s.analyticsOptIn);
      setTheme(s.theme);
      setDefaultModel(s.model);
      setDefaultThinking(s.thinkingLevel);
      setMultiChat(s.multiChat);
      setCommunityLore(s.useCommunityLore);
      setAutoLaunch(s.autoLaunch);
      setSkipPermissions(s.dangerouslySkipPermissions);
      setLoaded(true);
    });
    void window.modmixer.listModels().then(setModelOptions);
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

  const changeMultiChat = async (next: boolean) => {
    setMultiChat(next);
    await window.modmixer.setMultiChat(next);
  };

  const changeCommunityLore = async (next: boolean) => {
    setCommunityLore(next);
    await window.modmixer.setCommunityLore(next);
  };

  const changeAutoLaunch = async (next: boolean) => {
    setAutoLaunch(next);
    await window.modmixer.setAutoLaunch(next);
  };

  const changeSkipPermissions = async (next: boolean) => {
    setSkipPermissions(next);
    await window.modmixer.setDangerouslySkipPermissions(next);
  };

  const sectionTitle =
    section === 'providers'
      ? 'AI providers'
      : section === 'appearance'
        ? 'Appearance'
        : section === 'games'
          ? 'Games'
          : section === 'advanced'
            ? 'Advanced'
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
            label="General"
            active={section === 'general'}
            onClick={() => setSection('general')}
          />
          <SectionTab
            label="AI providers"
            active={section === 'providers'}
            onClick={() => setSection('providers')}
          />
          <SectionTab
            label="Games"
            active={section === 'games'}
            onClick={() => setSection('games')}
          />
          <SectionTab
            label="Appearance"
            active={section === 'appearance'}
            onClick={() => setSection('appearance')}
          />
          <SectionTab
            label="Advanced"
            active={section === 'advanced'}
            onClick={() => setSection('advanced')}
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
            {section === 'games' && <GamesSection />}
            {section === 'advanced' &&
              (!loaded ? (
                <p className="text-sm text-muted">Loading…</p>
              ) : (
                <AdvancedSection
                  multiChat={multiChat}
                  onMultiChatChange={changeMultiChat}
                  skipPermissions={skipPermissions}
                  onSkipPermissionsChange={changeSkipPermissions}
                />
              ))}
            {section === 'general' && (
              <>
                {!loaded ? (
                  <p className="text-sm text-muted">Loading…</p>
                ) : (
                  <div className="space-y-4">
                    <UpdateRow />
                    <div>
                      <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
                        Default model for new chats
                      </label>
                      <div className="flex flex-wrap items-center gap-2">
                        <ModelPicker
                          models={modelOptions}
                          current={defaultModel}
                          onChange={(sel) => {
                            setDefaultModel(sel);
                            void window.modmixer.setModel(sel);
                          }}
                          onConnect={() => setSection('providers')}
                        />
                        <ThinkingPicker
                          current={defaultThinking}
                          onChange={(level) => {
                            setDefaultThinking(level);
                            void window.modmixer.setThinkingLevel(level);
                          }}
                        />
                      </div>
                      <p className="mt-1.5 text-xs text-muted">
                        New chats start with these. Change a chat's model or
                        thinking level any time from its own toolbar — that
                        only affects that chat.
                      </p>
                    </div>
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
                          checked={autoLaunch}
                          onChange={(e) =>
                            void changeAutoLaunch(e.target.checked)
                          }
                          className="mt-0.5"
                        />
                        <span className="text-sm text-ink">
                          Launch the game automatically when ready to test
                          <span className="mt-0.5 block text-xs text-muted">
                            On: the agent launches as soon as a build is green
                            or a change is ready to try. Off (default): it asks
                            first — you confirm in chat or hit the Launch button
                            up top. Applies to new chats; open chats keep the
                            mode they started with.
                          </span>
                        </span>
                      </label>
                    </div>

                    <div>
                      <label className="flex cursor-pointer items-start gap-2">
                        <input
                          type="checkbox"
                          checked={communityLore}
                          onChange={(e) =>
                            void changeCommunityLore(e.target.checked)
                          }
                          className="mt-0.5"
                        />
                        <span className="text-sm text-ink">
                          Share community lore
                          <span className="mt-0.5 block text-xs text-muted">
                            Uploads your modding lesson notes (e.g. "SoundDef
                            volume scale is 0–100") to help other users — and
                            pulls everyone else's lessons back so your agent
                            gets smarter too.
                          </span>
                        </span>
                      </label>
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

function GamesSection() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Every game is available. A game is “set up” once Modmixer has discovered
        its install and built its code index. Setup starts automatically the
        first time you create a mod for a game, or you can trigger it here.
      </p>

      <div className="space-y-3">
        {getSelectableGames().map((game) => (
          <GameSetupCard key={game.id} game={game} />
        ))}
      </div>
    </div>
  );
}

/**
 * One per-game setup card. The third consumer of the shared setup path: it
 * renders the same <GameSetupBody> the onboarding step and the pre-chat gate
 * use — prerequisite checks (with their fix actions) + index status/progress —
 * differing only in that it never auto-builds (Settings lists every game, so a
 * heavy build must be user-triggered) and offers a manual rebuild ("redo")
 * button. Adding a game needs no change here.
 */
function GameSetupCard({ game }: { game: GameDefinition }) {
  const view = useGameSetup(game.id, true);
  const status = view.snapshot?.status ?? null;

  return (
    <div className="rounded-md border border-line bg-surface/30 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-medium text-ink">
          <GameIcon game={game.id} className="h-5 w-5" />
          {game.displayName}
          {game.beta && (
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-warning">
              Beta
            </span>
          )}
        </span>
        <SetupStateBadge state={status?.state ?? null} />
      </div>

      {status?.detail && (
        <p className="mt-1 text-xs text-muted">{status.detail}</p>
      )}

      <div className="mt-3">
        <GameSetupBody
          game={game.id}
          view={view}
          autoBuild={{ absent: false, stale: false }}
          requirementsFilter="all"
          showRebuild
        />
      </div>
    </div>
  );
}

function SetupStateBadge({ state }: { state: GameSetupState | null }) {
  if (state === null) {
    return (
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
        …
      </span>
    );
  }
  const tone =
    state === 'fresh'
      ? 'text-ready'
      : state === 'building'
        ? 'text-accent'
        : state === 'stale'
          ? 'text-warning'
          : 'text-muted';
  const label =
    state === 'fresh'
      ? 'Ready'
      : state === 'building'
        ? 'Setting up…'
        : state === 'stale'
          ? 'Update available'
          : state === 'blocked'
            ? 'Blocked'
            : 'Not set up';
  return (
    <span
      className={`font-mono text-[10px] uppercase tracking-[0.18em] ${tone}`}
    >
      {label}
    </span>
  );
}

function AdvancedSection({
  multiChat,
  onMultiChatChange,
  skipPermissions,
  onSkipPermissionsChange,
}: {
  multiChat: boolean;
  onMultiChatChange: (next: boolean) => void | Promise<void>;
  skipPermissions: boolean;
  onSkipPermissionsChange: (next: boolean) => void | Promise<void>;
}) {
  // Enabling the bypass is a two-step action: ticking the box opens a
  // confirmation rather than flipping it immediately. Turning it off is one
  // click. Local to the section so it resets when the dialog reopens.
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="space-y-4">
      <div>
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={multiChat}
            onChange={(e) => void onMultiChatChange(e.target.checked)}
            className="mt-0.5"
          />
          <span className="text-sm text-ink">
            Multiple chats per mod
            <span className="mt-0.5 block text-xs text-muted">
              Keep more than one chat per mod and switch between them from the
              sidebar — chats can even run at the same time. With this off,
              each mod has a single chat and starting a new one archives the
              old.
            </span>
          </span>
        </label>
        {multiChat && (
          <div className="mt-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning">
            Chats that run at the same time can edit the same mod files with no
            coordination — if two chats change the same code at once, one can
            overwrite the other's work. Keep parallel chats on separate tasks.
          </div>
        )}
      </div>

      <div className="border-t border-line pt-4">
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={skipPermissions}
            onChange={(e) => {
              if (e.target.checked) {
                // Require an explicit confirmation before turning it on.
                setConfirming(true);
              } else {
                setConfirming(false);
                void onSkipPermissionsChange(false);
              }
            }}
            className="mt-0.5"
          />
          <span className="text-sm text-ink">
            Skip all permission prompts{' '}
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-failed">
              Dangerous
            </span>
            <span className="mt-0.5 block text-xs text-muted">
              The agent runs every action — editing files, deleting things,
              running shell commands, changing your game install — without
              asking first. Saves clicks but removes the safety net. Stays on
              across restarts until you turn it off.
            </span>
          </span>
        </label>

        {confirming && !skipPermissions && (
          <div className="mt-2 space-y-2.5 rounded-md border border-failed/50 bg-failed/5 px-3 py-2.5 text-xs text-failed">
            <p>
              This lets the agent{' '}
              <strong>delete files and run any shell command on your
              computer</strong>{' '}
              with no confirmation. Mistakes — and any instructions hidden in
              files or web content the model reads — execute immediately. Only
              enable this if you trust the model and the task.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/30 hover:text-ink"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  void onSkipPermissionsChange(true);
                }}
                className="rounded-md border border-failed/60 bg-failed/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-failed transition-colors hover:bg-failed/20"
              >
                Enable anyway
              </button>
            </div>
          </div>
        )}

        {skipPermissions && (
          <div className="mt-2 rounded-md border border-failed/50 bg-failed/5 px-3 py-2 text-xs text-failed">
            Permission prompts are off. The agent can modify or delete files and
            run shell commands without asking. Turn this off when you're done.
          </div>
        )}
      </div>

      <div className="border-t border-line pt-4">
        <div className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={() => void window.modmixer.editGlobalInstructions()}
            title="Open ~/.modmixer/AGENTS.md — standing instructions added to every new chat. Applies to new chats only."
            className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted/70 transition-colors hover:text-ink"
          >
            Edit AGENTS.md
          </button>
          <button
            type="button"
            onClick={() => void window.modmixer.revealSkillsDir()}
            title="Open ~/.modmixer/skills — drop in a <name>/SKILL.md per skill (a reusable instruction packet the assistant reads on demand). See the README created in that folder. Applies to new chats only."
            className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted/70 transition-colors hover:text-ink"
          >
            Skill Folder
          </button>
          <button
            type="button"
            onClick={() => void window.modmixer.revealLoreDir()}
            title="Reveal the folder where Modmixer stores cross-mod modding lessons learned during your sessions."
            className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted/70 transition-colors hover:text-ink"
          >
            Lore Folder
          </button>
        </div>
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
  instructions?: string;
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
            instructions: event.authInfo?.instructions,
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

      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-line" />
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          Or run models locally
        </span>
        <span className="h-px flex-1 bg-line" />
      </div>

      <LocalProvidersSection />
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

interface LocalPreset {
  label: string;
  baseUrl: string;
}

// Defaults match each tool's documented OpenAI-compatible endpoint. They're
// editable after creation — the preset just primes the input fields so the
// common case is one click.
const LOCAL_PRESETS: LocalPreset[] = [
  { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
  { label: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
  { label: 'llama.cpp', baseUrl: 'http://localhost:8080/v1' },
  { label: 'vLLM', baseUrl: 'http://localhost:8000/v1' },
];

function LocalProvidersSection() {
  const [providers, setProviders] = useState<LocalProvider[] | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = () => {
    void window.modmixer.listLocalProviders().then(setProviders);
  };

  useEffect(() => {
    refresh();
  }, []);

  if (!providers) return null;

  return (
    <div className="space-y-3 rounded-md border border-line">
      <div className="border-b border-line px-3 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-ink">Local models</div>
            <div className="mt-0.5 text-[11px] text-muted">
              Point Modmixer at any OpenAI-compatible server running on your
              machine — LM Studio, Ollama, llama.cpp, vLLM. Tool-calling
              quality varies a lot by model.
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-3 px-3 pb-3">
        {providers.length === 0 && !adding && (
          <p className="text-[11px] text-muted">
            No local servers configured yet.
          </p>
        )}

        {providers.map((p) => (
          <LocalProviderRow
            key={p.id}
            provider={p}
            onChange={setProviders}
          />
        ))}

        {adding ? (
          <LocalProviderForm
            onSave={async (input) => {
              const next = await window.modmixer.addLocalProvider(input);
              setProviders(next);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="rounded-md border border-dashed border-line bg-paper px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/30 hover:text-ink"
          >
            + Add local server
          </button>
        )}
      </div>
    </div>
  );
}

function LocalProviderForm({
  onSave,
  onCancel,
  initial,
}: {
  onSave: (input: {
    label: string;
    baseUrl: string;
    apiKey?: string | null;
  }) => Promise<void> | void;
  onCancel: () => void;
  initial?: { label: string; baseUrl: string };
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  const applyPreset = (preset: LocalPreset) => {
    if (!label.trim()) setLabel(preset.label);
    setBaseUrl(preset.baseUrl);
  };

  const canSave = label.trim().length > 0 && baseUrl.trim().length > 0;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave({
        label,
        baseUrl,
        apiKey: apiKey.trim() ? apiKey : null,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-line bg-surface/40 px-3 py-2.5">
      {!initial && (
        <div className="flex flex-wrap gap-1.5">
          {LOCAL_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(p)}
              className="rounded-md border border-line bg-paper px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/30 hover:text-ink"
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
        <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          Name
        </label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="LM Studio"
          className="rounded-md border border-line bg-paper px-2 py-1 font-mono text-xs text-ink focus:border-accent focus:outline-none"
        />

        <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          URL
        </label>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://localhost:1234/v1"
          className="rounded-md border border-line bg-paper px-2 py-1 font-mono text-xs text-ink focus:border-accent focus:outline-none"
        />

        <label className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          API key
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="(usually not needed)"
          className="rounded-md border border-line bg-paper px-2 py-1 font-mono text-xs text-ink focus:border-accent focus:outline-none"
        />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/30 hover:text-ink disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !canSave}
          className="rounded-md bg-accent px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-accent-foreground transition-opacity hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function LocalProviderRow({
  provider,
  onChange,
}: {
  provider: LocalProvider;
  onChange: (next: LocalProvider[]) => void;
}) {
  const [modelInput, setModelInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [discovered, setDiscovered] = useState<string[] | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  const addModel = async (id: string) => {
    const cleaned = id.trim();
    if (!cleaned) return;
    setBusy(true);
    try {
      const next = await window.modmixer.addLocalModel(provider.id, cleaned);
      onChange(next);
      setModelInput('');
    } finally {
      setBusy(false);
    }
  };

  const removeModel = async (modelId: string) => {
    const next = await window.modmixer.removeLocalModel(provider.id, modelId);
    onChange(next);
  };

  const removeProvider = async () => {
    const next = await window.modmixer.removeLocalProvider(provider.id);
    onChange(next);
  };

  const discover = async () => {
    setDiscoverError(null);
    setBusy(true);
    try {
      const ids = await window.modmixer.discoverLocalModels(provider.baseUrl);
      setDiscovered(ids);
      if (ids.length === 0) {
        setDiscoverError('Server returned no models.');
      }
    } catch (err) {
      setDiscoverError(err instanceof Error ? err.message : String(err));
      setDiscovered(null);
    } finally {
      setBusy(false);
    }
  };

  const unlisted = discovered
    ? discovered.filter((id) => !provider.models.includes(id))
    : [];

  return (
    <div className="space-y-2 rounded-md border border-line bg-paper/40 px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-ink">{provider.label}</div>
          <div className="truncate font-mono text-[11px] text-muted">
            {provider.baseUrl}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void removeProvider()}
          className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-failed"
        >
          Remove
        </button>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={modelInput}
          onChange={(e) => setModelInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && modelInput.trim()) void addModel(modelInput);
          }}
          placeholder="qwen3-coder, llama3.1, …"
          className="flex-1 rounded-md border border-line bg-paper px-2 py-1 font-mono text-xs text-ink focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void addModel(modelInput)}
          disabled={busy || !modelInput.trim()}
          className="rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/30 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          Add
        </button>
        <button
          type="button"
          onClick={() => void discover()}
          disabled={busy}
          className="rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/30 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          title="Fetch /models from the server and list what it's serving"
        >
          Discover
        </button>
      </div>

      {discoverError && (
        <div className="rounded-md border border-failed/40 bg-failed/5 px-2 py-1 text-[11px] text-failed">
          {discoverError}
        </div>
      )}

      {unlisted.length > 0 && (
        <div className="space-y-1 rounded-md border border-line bg-surface/40 p-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
            Available on server
          </p>
          <div className="flex flex-wrap gap-1.5">
            {unlisted.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => void addModel(id)}
                disabled={busy}
                className="rounded-md border border-line bg-paper px-2 py-0.5 font-mono text-[10px] text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
              >
                + {id}
              </button>
            ))}
          </div>
        </div>
      )}

      {provider.models.length > 0 && (
        <ul className="divide-y divide-line rounded-md border border-line">
          {provider.models.map((id) => (
            <li
              key={id}
              className="flex items-center justify-between px-2.5 py-1.5"
            >
              <span className="font-mono text-xs text-ink">{id}</span>
              <button
                onClick={() => void removeModel(id)}
                className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-failed"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
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
          {progress.instructions && (
            <div className="mt-1.5 font-mono text-sm font-semibold tracking-wide text-ink">
              {progress.instructions}
            </div>
          )}
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
