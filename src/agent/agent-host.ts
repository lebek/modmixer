import { app, shell, type BrowserWindow } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import {
  AgentSession,
  AuthStorage,
  CURRENT_SESSION_VERSION,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSessionEvent,
  type ContextUsage,
  type SessionHeader,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import type {
  Api,
  Model,
  OAuthAuthInfo,
  OAuthPrompt,
  OAuthProviderId,
} from '@mariozechner/pi-ai';
import type { AgentTool, ThinkingLevel } from '@mariozechner/pi-agent-core';
import {
  formatErrorSummary,
  getLogWatcher,
  type LogErrorGroup,
} from './log-watcher.js';
import { isRimWorldRunning } from './game.js';
import { createScaffoldModTool } from './tools/scaffold-mod.js';
import { setModMetadataTool } from './tools/set-mod-metadata.js';
import { updateSchematicTool } from './tools/update-schematic.js';
import { buildModTool } from './tools/build-mod.js';
import { launchRimWorldTool } from './tools/launch-rimworld.js';
import { tailPlayerLogTool } from './tools/tail-player-log.js';
import { listInstalledModsTool } from './tools/list-installed-mods.js';
import { decompileDllTool } from './tools/decompile-dll.js';
import { renderSvgToPngTool } from './tools/render-svg-to-png.js';
import { renderPreviewTool } from './tools/render-preview.js';
import { searchDefsTool } from './tools/search-defs.js';
import { getDefDetailsTool } from './tools/get-def-details.js';
import { listDefDescendantsTool } from './tools/list-def-descendants.js';
import { readCsharpSymbolTool } from './tools/read-csharp-symbol.js';
import { resolveSymbolTool } from './tools/resolve-symbol.js';
import { searchSourceTool } from './tools/search-source.js';
import { whoUsesDefTool } from './tools/who-uses-def.js';
import { readLoreTool } from './tools/read-lore.js';
import { saveLoreTool } from './tools/save-lore.js';
import { createGuardedBashTool } from './tools/bash.js';
import {
  createGuardedEditTool,
  createGuardedFindTool,
  createGuardedGrepTool,
  createGuardedLsTool,
  createGuardedReadTool,
  createGuardedWriteTool,
} from './tools/path-guarded.js';
import { syncToGameTool, unsyncFromGameTool } from './tools/sync-to-game.js';
import { shipAndLaunchTool } from './tools/ship-and-launch.js';
import { withConfirmation } from './security/with-confirmation.js';
import { setActiveModsTool } from './tools/set-active-mods.js';
import { autosortModsTool } from './tools/autosort-mods.js';
import { startFixSessionTool } from './tools/start-fix-session.js';
import { startTestSessionTool } from './tools/start-test-session.js';
import {
  applySessionTool,
  revertSessionTool,
} from './tools/apply-revert-session.js';
import { getSessionManager } from './registry/index.js';
import { SafeStorageAuthBackend } from './security/secure-auth-storage.js';
import {
  enableModInGameTool,
  disableModInGameTool,
} from './tools/enable-mod-in-game.js';
import { quitRimWorldTool } from './tools/quit-rimworld.js';
import { prepareDebugSessionTool } from './tools/prepare-debug-session.js';
import { isRimWorldRunningTool } from './tools/is-rimworld-running.js';
import { watchPlayerLogTool } from './tools/watch-player-log.js';
import { notifyTestStatusTool } from './tools/notify-test-status.js';
import { sendToast } from './notifications.js';
import { loadSettings, saveSettings } from './settings.js';
import {
  fetchOpenRouterPricing,
  getCachedOpenRouterPricing,
  isOpenRouterPricingStale,
  type OpenRouterCost,
} from './openrouter-pricing.js';
import {
  fetchOpenRouterCredits,
  type OpenRouterCredits,
} from './openrouter-credits.js';
import { getWorkspacePaths } from './workspace.js';
import { ScopedResourceLoader } from './resource-loader.js';
import { buildSystemPrompt } from './system-prompt.js';
import {
  addConversation,
  getConversation,
  isDefaultTitle,
  removeConversation,
  setActiveForMod,
  setScope,
  setSystemPrompt,
  setTitle,
  touch,
  type Conversation,
  type ConversationScope,
} from './conversations.js';
import { messageText } from '../lib/agent-utils.js';
import type { ModelOption } from './models.js';
import type { ModelSelection } from './settings.js';

const RIMWORLD_POLL_INTERVAL_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Mod-mixer-specific tools, plus a path-policy-guarded `bash` that overrides
 * pi's built-in (custom tools win by name in `_refreshToolRegistry`). The
 * bash tool is constructed with a cwd, so it lives inside the host instead
 * of at module scope.
 */
function buildCustomTools(
  cwd: string,
  getActiveScope: () => ConversationScope | null,
): AgentTool<any>[] {
  return [
    createScaffoldModTool(getActiveScope),
    setModMetadataTool,
    updateSchematicTool,
    syncToGameTool,
    unsyncFromGameTool,
    enableModInGameTool,
    disableModInGameTool,
    prepareDebugSessionTool,
    buildModTool,
    launchRimWorldTool,
    shipAndLaunchTool,
    // quit_rimworld may drop unsaved game progress.
    withConfirmation(quitRimWorldTool, {
      label: 'Force-quit RimWorld',
      summary: 'Send a quit signal to RimWorld. Unsaved game progress will be lost.',
    }),
    isRimWorldRunningTool,
    watchPlayerLogTool,
    notifyTestStatusTool,
    tailPlayerLogTool,
    listInstalledModsTool,
    decompileDllTool,
    renderSvgToPngTool,
    renderPreviewTool,
    // Mod-list manipulation: gated, but auto-approved inside an active fix
    // session so the agent can iterate freely.
    withConfirmation(
      setActiveModsTool,
      {
        label: 'Replace active mod list',
        summary:
          "Bulk-replace ModsConfig.xml's active mod list. RimWorld must be closed. The previous list is backed up automatically.",
      },
      {
        shouldAutoApprove: () => getSessionManager().getActive() !== null,
        summarize: (p: { packageIds: string[] }) =>
          `Set ${p.packageIds.length} active mod(s).`,
      },
    ),
    withConfirmation(
      autosortModsTool,
      {
        label: 'Autosort mod list',
        summary:
          "Reorder ModsConfig.xml's active mods according to About.xml deps and the community rules DB.",
      },
      {
        shouldAutoApprove: () => getSessionManager().getActive() !== null,
        summarize: (p: { apply?: boolean }) =>
          p.apply
            ? 'Apply autosort to ModsConfig.xml.'
            : 'Preview autosort proposal (no write).',
      },
    ),
    startTestSessionTool,
    startFixSessionTool,
    applySessionTool,
    revertSessionTool,
    // RimWorld source/def index — read-only lookups against $MM/index/*.
    searchDefsTool,
    getDefDetailsTool,
    listDefDescendantsTool,
    readCsharpSymbolTool,
    resolveSymbolTool,
    searchSourceTool,
    whoUsesDefTool,
    readLoreTool,
    saveLoreTool,
    // bash is the catch-all for arbitrary shell exec. The path-policy guard
    // is the safety net; the confirmation prompt is the user-facing brake.
    withConfirmation(createGuardedBashTool(cwd), {
      label: 'Run shell command',
      summary: 'Execute a shell command in the modmixer workspace.',
    }, (p: { command: string }) => `Run “${p.command.length > 120 ? p.command.slice(0, 119) + '…' : p.command}” in the modmixer workspace.`),
    // Override pi's path-shaped built-ins with versions that enforce the
    // allowlist. Custom tools win over built-ins by name in pi's
    // `_refreshToolRegistry`, so these shadow the defaults entirely.
    createGuardedReadTool(cwd),
    createGuardedWriteTool(cwd),
    createGuardedEditTool(cwd),
    createGuardedGrepTool(cwd),
    createGuardedFindTool(cwd),
    createGuardedLsTool(cwd),
  ];
}

const BUILTIN_TOOL_NAMES = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

/** Friendly provider labels surfaced in the UI. Falls back to the raw id. */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Claude',
  'openai-codex': 'ChatGPT',
  'github-copilot': 'GitHub Copilot',
  'google-gemini-cli': 'Gemini',
  'google-antigravity': 'Antigravity',
  openrouter: 'OpenRouter',
};

const OPENROUTER_PROVIDER = 'openrouter';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * Per-provider curation: pi-ai knows about ~80 models across our supported
 * OAuth providers (claude-3-haiku from 2024, gpt-4-turbo, etc.) — most aren't
 * what someone picking "an AI to write RimWorld mods" wants. The picker shows
 * only the IDs listed here. Update when new flagships ship.
 */
const FEATURED_MODELS: Record<string, string[]> = {
  anthropic: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  'openai-codex': ['gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex'],
  'github-copilot': [
    'claude-opus-4.7',
    'claude-sonnet-4.6',
    'gpt-5.5',
    'gemini-3.1-pro-preview',
  ],
  'google-gemini-cli': [
    'gemini-3.1-pro-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
  ],
  'google-antigravity': [
    'gemini-3.1-pro-high',
    'claude-sonnet-4-6',
    'claude-opus-4-6-thinking',
  ],
};

/**
 * Per-provider default: a Sonnet-tier model — capable enough for real mod
 * work, cheap enough to leave running. Picked when the user hasn't chosen
 * one yet, so we don't strand them on the cheapest or burn through Opus
 * usage by accident. Must be present in FEATURED_MODELS for the same provider.
 */
const DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  'openai-codex': 'gpt-5.4',
  'github-copilot': 'claude-sonnet-4.6',
  'google-gemini-cli': 'gemini-2.5-pro',
  'google-antigravity': 'claude-sonnet-4-6',
};

/**
 * Rough cost band shown next to each model in the picker. '$' = cheap/fast,
 * '$$' = mid (Sonnet-tier), '$$$' = flagship. These are coarse buckets, not
 * exact pricing — the goal is to help the user avoid accidentally selecting
 * the most expensive option.
 */
const MODEL_COST_TIER: Record<string, '$' | '$$' | '$$$'> = {
  // Anthropic
  'claude-opus-4-7': '$$$',
  'claude-sonnet-4-6': '$$',
  'claude-haiku-4-5': '$',
  'claude-opus-4-6-thinking': '$$$',
  // OpenAI
  'gpt-5.5': '$$$',
  'gpt-5.4': '$$',
  'gpt-5.3-codex': '$',
  // GitHub Copilot (uses dotted ids)
  'claude-opus-4.7': '$$$',
  'claude-sonnet-4.6': '$$',
  // Google
  'gemini-3.1-pro-preview': '$$$',
  'gemini-3.1-pro-high': '$$$',
  'gemini-2.5-pro': '$$',
  'gemini-2.5-flash': '$',
};

export interface OpenRouterConfig {
  /** True when an API key is persisted in encrypted AuthStorage. */
  apiKeyConfigured: boolean;
  /** Slugs the user has saved (rendered as model picker entries). */
  models: string[];
}

export interface OAuthLink {
  id: string;
  /** pi-mono's full provider name (e.g. "Anthropic (Claude Pro/Max)"). */
  name: string;
  /** Short label we surface in the UI ("Claude", "ChatGPT"). */
  label: string;
  linked: boolean;
  /** Where pi found credentials for this provider, if any. */
  source?: 'stored' | 'runtime' | 'environment' | 'fallback' | 'models_json_key' | 'models_json_command';
  usesCallbackServer: boolean;
}

export type OAuthEvent =
  | { type: 'login-start'; providerId: string }
  | {
      type: 'login-progress';
      providerId: string;
      message: string;
      authInfo?: { url: string; instructions?: string };
    }
  | {
      type: 'prompt-needed';
      providerId: string;
      message: string;
      placeholder?: string;
      allowEmpty?: boolean;
    }
  | { type: 'login-success'; providerId: string }
  | { type: 'login-error'; providerId: string; message: string }
  | { type: 'login-cancelled'; providerId: string }
  | { type: 'logout'; providerId: string }
  | { type: 'links-changed' };

/**
 * Inlined from pi-coding-agent's session-manager (the function exists but is
 * not re-exported from the package's public barrel in 0.70.6). Same encoding
 * scheme so SessionManager methods that compute paths internally land on the
 * same files we manage.
 */
function getDefaultSessionDir(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const sessionDir = path.join(agentDir, 'sessions', safePath);
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

/** Inlined from pi-coding-agent (also not re-exported in 0.70.6). */
function toolDefinitionFromAgentTool(
  tool: AgentTool<any>,
): ToolDefinition<any, unknown> {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters as any,
    prepareArguments: tool.prepareArguments,
    executionMode: tool.executionMode,
    execute: async (toolCallId, params, signal, onUpdate) =>
      tool.execute(toolCallId, params, signal, onUpdate),
  };
}

let hostInstance: AgentHost | null = null;
export function getAgentHost(): AgentHost {
  if (!hostInstance) throw new Error('AgentHost not initialized');
  return hostInstance;
}

interface ActiveSession {
  conversationId: string;
  scope: ConversationScope;
  session: AgentSession;
  unsubscribe: () => void;
}

export class AgentHost {
  private readonly getWindow: () => BrowserWindow | null;
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly sessionDir: string;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly settingsManager: SettingsManager;
  private readonly customTools: ToolDefinition[];
  private readonly allowedToolNames: string[];

  private active: ActiveSession | null = null;
  /**
   * Set when an in-flight tool call (currently only scaffold_mod) updates the
   * conversation scope. The next send() reconstructs the AgentSession against
   * the new scope before prompting, so the user's next message hits a fresh
   * system prompt without us having to mutate one in flight.
   */
  private pendingScopeReload: ConversationScope | null = null;

  // Background log monitoring (test-in-game flow). Tied to a specific
  // conversation, dropped when the user switches away.
  private logUnsubscribe: (() => void) | null = null;
  private rimworldPollTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private monitoringConversationId: string | null = null;

  /**
   * Single-flight OAuth login. A new login attempt aborts any in-flight one.
   * Anthropic's callback server is hardcoded to port 53692, so concurrent
   * logins would EADDRINUSE.
   */
  private pendingOAuth: {
    providerId: string;
    abort: AbortController;
    resolvePrompt: ((value: string) => void) | null;
    rejectPrompt: ((err: Error) => void) | null;
  } | null = null;

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
    hostInstance = this;
    const { workspaceDir } = getWorkspacePaths();
    this.cwd = workspaceDir;
    this.agentDir = path.join(app.getPath('userData'), 'pi-agent');
    fs.mkdirSync(this.agentDir, { recursive: true });
    this.sessionDir = getDefaultSessionDir(this.cwd, this.agentDir);
    // OAuth tokens are encrypted at rest via Electron safeStorage (Keychain
    // on macOS, DPAPI on Windows, libsecret on Linux). The backend migrates
    // any pre-existing plaintext `auth.json` to `auth.enc` on first read
    // and deletes the plaintext file once the encrypted copy is in place.
    this.authStorage = AuthStorage.fromStorage(
      new SafeStorageAuthBackend(
        path.join(this.agentDir, 'auth.enc'),
        path.join(this.agentDir, 'auth.json'),
      ),
    );
    this.modelRegistry = ModelRegistry.create(
      this.authStorage,
      path.join(this.agentDir, 'models.json'),
    );
    this.settingsManager = SettingsManager.create(this.cwd, this.agentDir);
    const customAgentTools = buildCustomTools(this.cwd, () => this.active?.scope ?? null);
    this.allowedToolNames = [
      ...BUILTIN_TOOL_NAMES,
      ...customAgentTools
        .map((t) => t.name)
        .filter((n) => !BUILTIN_TOOL_NAMES.includes(n)),
    ];
    this.customTools = customAgentTools.map((tool) =>
      toolDefinitionFromAgentTool(tool),
    );
  }

  /**
   * Re-read AuthStorage from disk. Called from main.ts once `app.ready`
   * fires — the host constructor runs before that, and on Linux/Windows
   * `safeStorage.isEncryptionAvailable()` returns false until ready, so the
   * initial reload comes back empty even when the user has saved creds. A
   * post-ready prime() refresh makes those creds visible to the model
   * picker without forcing the user to re-login.
   */
  primeAfterReady(): void {
    try {
      this.authStorage.reload();
      this.modelRegistry.refresh();
      this.applyOpenRouterRegistration();
    } catch (err) {
      console.error('AgentHost.primeAfterReady failed:', err);
    }
    // Best-effort pricing prime: cached map is consulted by the
    // registration above. If the cache is empty or stale, refresh in the
    // background and re-register so subsequent turns pick up real rates.
    if (!getCachedOpenRouterPricing() || isOpenRouterPricingStale()) {
      void fetchOpenRouterPricing()
        .then(() => {
          try {
            this.applyOpenRouterRegistration();
          } catch (err) {
            console.error(
              'AgentHost: failed to re-register openrouter after pricing fetch:',
              err,
            );
          }
        })
        .catch(() => {
          // Pricing fetch is best-effort — failures just leave $0 rates in
          // place until the next launch.
        });
    }
  }

  /**
   * Register the user's saved OpenRouter slugs as runtime models in pi's
   * registry. Pi's built-in openrouter catalog includes ~300 entries, but
   * the picker only surfaces what the user has explicitly saved here —
   * registering replaces those built-ins with our short list. Per-million
   * token rates are pulled from the cached OpenRouter catalogue (see
   * `openrouter-pricing.ts`); slugs missing from the cache fall back to
   * zero, which renders as "$0" in the UI until the next refresh lands.
   */
  private applyOpenRouterRegistration(): void {
    const { openrouterModels } = loadSettings();
    if (openrouterModels.length === 0) {
      // No models saved → don't touch pi's built-in openrouter list.
      return;
    }
    // Pi's `registerProvider` validates that an apiKey is present whenever
    // models are defined (the value isn't actually consumed at request time
    // — the real lookup goes through AuthStorage — but it has to be set).
    // Pull it sync from AuthStorage, falling back to the env var so users
    // with `OPENROUTER_API_KEY` exported also get their slugs registered.
    const cred = this.authStorage.get(OPENROUTER_PROVIDER);
    const apiKey =
      cred?.type === 'api_key' ? cred.key : process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      // No key available → skip registration. The slug still shows in the
      // picker; sending a turn surfaces the missing-key error.
      return;
    }
    const pricing = getCachedOpenRouterPricing() ?? {};
    const zero: OpenRouterCost = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    const pricingFor = (slug: string): OpenRouterCost => pricing[slug] ?? zero;
    this.modelRegistry.registerProvider(OPENROUTER_PROVIDER, {
      baseUrl: OPENROUTER_BASE_URL,
      api: 'openai-completions',
      apiKey,
      // OpenRouter app-attribution headers — show our app name and link on
      // https://openrouter.ai/rankings. Overrides pi-coding-agent's built-in
      // defaults (which point to pi.dev / "pi"). `HTTP-Referer` is what
      // OpenRouter scrapes for the listing; `X-Title` is the display
      // override. The `X-OpenRouter-*` keys are pi-mono's own bespoke
      // labels (not part of OpenRouter's spec) — overridden so we don't
      // identify as "pi" anywhere in the request.
      // https://openrouter.ai/docs/app-attribution
      headers: {
        'HTTP-Referer': 'https://modmixer.com',
        'X-Title': 'Modmixer',
        'X-OpenRouter-Title': 'Modmixer',
        'X-OpenRouter-Categories': 'programming-app,game',
      },
      models: openrouterModels.map((slug) => ({
        id: slug,
        name: slug,
        reasoning: false,
        input: ['text'],
        cost: pricingFor(slug),
        // 200k is a safe upper bound for "modern" OpenRouter models; the
        // actual limit is enforced server-side regardless of what we say.
        contextWindow: 200_000,
        maxTokens: 8192,
        // Kimi K2 emits tool calls in its native `<|tool_call_begin|>` format
        // that requires the `kimi_k2` parser; not every OpenRouter sub-provider
        // ships it, so pin to Moonshot's own infra to avoid raw tokens leaking
        // into tool-call args.
        ...(slug.startsWith('moonshotai/kimi-k2')
          ? { compat: { openRouterRouting: { only: ['moonshotai'] } } }
          : slug.startsWith('deepseek/deepseek-v4')
            ? {
                compat: {
                  openRouterRouting: {
                    order: ['atlascloud'],
                    allow_fallbacks: true,
                  },
                },
              }
            : {}),
      })),
    });
  }

  /** Tear down the active session, if any. Used on app exit and on switch. */
  private async disposeActive(): Promise<void> {
    if (!this.active) return;
    try {
      await this.active.session.abort();
    } catch (err) {
      console.error('AgentSession.abort failed:', err);
    }
    this.active.unsubscribe();
    try {
      this.active.session.dispose();
    } catch (err) {
      console.error('AgentSession.dispose failed:', err);
    }
    this.active = null;
  }

  /**
   * Build a fresh AgentSession bound to the given conversation. The
   * conversation's session file is loaded if it exists; otherwise a new
   * empty session file is created.
   */
  /**
   * Resolve the user's saved model selection to an actual pi-ai Model object.
   * If the saved selection is unavailable (missing, no auth) we fall back to
   * the first OAuth-available model, then to any built-in model. The session
   * still constructs in the no-auth case so the UI can hydrate; send() will
   * fail at prompt time, but the chat panel gates that path anyway.
   */
  private resolveModel(): Model<Api> | null {
    const { model: saved } = loadSettings();
    if (saved) {
      const found = this.modelRegistry.find(saved.provider, saved.modelId);
      if (found && this.modelRegistry.hasConfiguredAuth(found)) return found;
    }
    // No valid saved selection — prefer the Sonnet-tier default of the first
    // linked provider over "first model registered," so a fresh install lands
    // on a sensible mid-tier model instead of whatever sorts first.
    for (const provider of Object.keys(FEATURED_MODELS)) {
      if (!this.authStorage.getAuthStatus(provider).configured) continue;
      const defaultId = DEFAULT_MODEL[provider];
      if (!defaultId) continue;
      const found = this.modelRegistry.find(provider, defaultId);
      if (found && this.modelRegistry.hasConfiguredAuth(found)) return found;
    }
    const available = this.modelRegistry.getAvailable();
    if (available.length > 0) return available[0];
    const all = this.modelRegistry.getAll();
    return all[0] ?? null;
  }

  private async constructSession(
    convo: Conversation,
  ): Promise<ActiveSession> {
    const model = this.resolveModel();
    if (!model) {
      throw new Error('No models registered in pi-ai — cannot construct session.');
    }
    const sessionManager = SessionManager.open(
      convo.sessionFile,
      this.sessionDir,
      this.cwd,
    );

    // The system prompt is snapshotted at conversation creation and reused
    // forever (see Conversation.systemPrompt for why — short version: keeps
    // OpenRouter's conversation hash stable so sticky provider routing
    // doesn't reset and lose the upstream prompt cache between turns).
    // Legacy conversations created before that field existed backfill on
    // first rehydration so they get the same stickiness from then on.
    let systemPrompt = convo.systemPrompt;
    if (systemPrompt === undefined) {
      systemPrompt = buildSystemPrompt(convo.scope);
      setSystemPrompt(convo.id, systemPrompt);
    }
    const resourceLoader = new ScopedResourceLoader(systemPrompt);

    const { thinkingLevel } = loadSettings();
    const { session } = await createAgentSession({
      cwd: this.cwd,
      agentDir: this.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settingsManager: this.settingsManager,
      sessionManager,
      resourceLoader,
      model,
      thinkingLevel,
      tools: this.allowedToolNames,
      customTools: this.customTools,
    });

    const unsubscribe = session.subscribe((event) =>
      this.onSessionEvent(convo.id, event),
    );

    return {
      conversationId: convo.id,
      scope: convo.scope,
      session,
      unsubscribe,
    };
  }

  /**
   * `win.isDestroyed()` and `webContents.isDestroyed()` aren't enough on
   * their own — the underlying render frame can be disposed mid-send (during
   * navigation, reload, or after a renderer crash) while the BrowserWindow
   * still reports alive, and `webContents.send` then throws
   * "Render frame was disposed before WebFrameMain could be accessed". The
   * AgentSession is decoupled from the renderer lifecycle and keeps emitting
   * events from in-flight work, so we just swallow the race here.
   */
  private sendToRenderer(channel: string, payload: unknown): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    if (wc.isDestroyed() || wc.isCrashed()) return;
    try {
      wc.send(channel, payload);
    } catch {
      // Render frame disposed mid-send; nothing actionable.
    }
  }

  private onSessionEvent(
    conversationId: string,
    event: AgentSessionEvent,
  ): void {
    this.sendToRenderer('modmixer:agent:event', {
      conversationId,
      event,
    });

    // Auto-title from the first user message as soon as it lands. Don't wait
    // for agent_end, which may never fire if the user closes the window
    // mid-turn.
    if (event.type === 'message_end' && event.message.role === 'user') {
      const convo = getConversation(conversationId);
      if (convo && isDefaultTitle(convo.title)) {
        const text = messageText(event.message).trim().slice(0, 60);
        if (text) setTitle(conversationId, text);
      }
    }

    if (event.type === 'message_end' || event.type === 'agent_end') {
      touch(conversationId);
    }

    // When scaffold_mod succeeds inside a "new" scope, upgrade the
    // conversation scope so future turns get a mod-scoped system prompt. We
    // can't swap the running session's prompt safely mid-turn, so we mark a
    // scope reload — the next send() will dispose and reconstruct against
    // the new scope.
    if (
      event.type === 'tool_execution_end' &&
      event.toolName === 'scaffold_mod' &&
      !event.isError &&
      this.active?.conversationId === conversationId &&
      this.active.scope.type === 'new'
    ) {
      const folder = (
        event.result?.details as { folder?: string } | undefined
      )?.folder;
      if (folder) {
        const nextScope: ConversationScope = {
          type: 'mod',
          modFolder: folder,
        };
        setScope(conversationId, nextScope);
        // Refresh the snapshot so subsequent rehydrations match the prompt
        // the freshly-reconstructed session is actually running with. This
        // upgrade is a deliberate, one-time hash change per conversation —
        // sticky routing re-picks here and then holds.
        setSystemPrompt(conversationId, buildSystemPrompt(nextScope));
        setActiveForMod(folder, conversationId);
        this.pendingScopeReload = nextScope;
        // Tell the renderer to re-hydrate the active conversation since the
        // scope (and thus the displayed mod context) changed underneath it.
        this.sendToRenderer('modmixer:agent:scope-upgraded', {
          conversationId,
          scope: nextScope,
        });
      }
    }
  }

  /** Public entry point used by IPC and by ourselves. */
  async switchTo(conversationId: string): Promise<Conversation> {
    const convo = getConversation(conversationId);
    if (!convo) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }

    // Switching cancels any background log monitoring tied to the prior
    // chat — errors won't auto-prompt into a different scope.
    if (
      this.monitoringConversationId &&
      this.monitoringConversationId !== conversationId
    ) {
      this.stopLogMonitoring();
    }

    if (
      this.active?.conversationId === conversationId &&
      !this.pendingScopeReload
    ) {
      return convo;
    }

    await this.disposeActive();
    this.active = await this.constructSession(convo);
    this.pendingScopeReload = null;
    return convo;
  }

  /** Returns the live messages for the active conversation. */
  getActiveMessages() {
    return this.active?.session.agent.state.messages ?? [];
  }

  getCurrentId(): string | null {
    return this.active?.conversationId ?? null;
  }

  getCurrentScope(): ConversationScope | null {
    return this.active?.scope ?? null;
  }

  /**
   * Create a new conversation entry and pre-write its session header to
   * disk. pi defers flushing until the first assistant message lands, but we
   * want a stable id ↔ session-file mapping in our index even before the
   * first message — otherwise SessionManager.open on a later switchTo would
   * mint a fresh id internally and our index id would diverge from the
   * eventual JSONL header.
   */
  async createConversation(
    scope: ConversationScope,
    title?: string,
  ): Promise<Conversation> {
    const sm = SessionManager.create(this.cwd, this.sessionDir);
    const id = sm.getSessionId();
    const sessionFile = sm.getSessionFile();
    if (!sessionFile) {
      throw new Error('SessionManager.create did not produce a session file');
    }
    const header: SessionHeader = {
      type: 'session',
      version: CURRENT_SESSION_VERSION,
      id,
      timestamp: new Date().toISOString(),
      cwd: this.cwd,
    };
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
    // Snapshot the system prompt up front so it's frozen for this
    // conversation's lifetime — see Conversation.systemPrompt.
    return addConversation({
      id,
      sessionFile,
      scope,
      title,
      systemPrompt: buildSystemPrompt(scope),
    });
  }

  async deleteConversation(id: string): Promise<void> {
    if (this.active?.conversationId === id) {
      await this.disposeActive();
    }
    const sessionFile = removeConversation(id);
    if (sessionFile && fs.existsSync(sessionFile)) {
      try {
        fs.unlinkSync(sessionFile);
      } catch (err) {
        console.error('Failed to delete session file:', sessionFile, err);
      }
    }
  }

  async send(text: string): Promise<void> {
    if (!this.active) {
      throw new Error('No active conversation. Switch to one first.');
    }
    if (this.pendingScopeReload) {
      const convo = getConversation(this.active.conversationId);
      if (convo) {
        await this.disposeActive();
        this.active = await this.constructSession(convo);
      }
      this.pendingScopeReload = null;
    }
    await this.active!.session.prompt(text, {
      streamingBehavior: 'steer',
      expandPromptTemplates: false,
    });
  }

  /**
   * Cancel the in-flight turn. Pi settles the run with `stopReason: "aborted"`
   * and emits `agent_end`, so the renderer's existing `busy` reset still fires.
   * No-op when there's no active session or no run in flight.
   */
  async interrupt(): Promise<void> {
    if (!this.active) return;
    await this.active.session.abort();
  }

  async setModel(selection: ModelSelection): Promise<void> {
    const model = this.modelRegistry.find(selection.provider, selection.modelId);
    if (!model) {
      throw new Error(
        `Unknown model: ${selection.provider}/${selection.modelId}`,
      );
    }
    if (this.active) {
      await this.active.session.setModel(model);
    }
  }

  /**
   * Apply the user's preferred thinking level to the active session. Pi
   * clamps internally against the model's available levels, so passing
   * "xhigh" to Kimi quietly becomes "high" inside the session — that's
   * fine; the saved preference (in settings.json) is the source of truth
   * across model switches.
   */
  setThinkingLevel(level: ThinkingLevel): void {
    if (this.active) {
      this.active.session.setThinkingLevel(level);
    }
  }

  /**
   * Re-bind the active session's model after credentials change (login /
   * logout). If the saved selection is no longer valid, the next available
   * model is used instead.
   */
  private async refreshActiveModel(): Promise<void> {
    if (!this.active) return;
    const model = this.resolveModel();
    if (!model) return;
    try {
      await this.active.session.setModel(model);
    } catch (err) {
      console.error('Failed to swap session model after auth change:', err);
    }
  }

  // =========================================================================
  // Models / OAuth (UI-facing, called from main.ts IPC handlers)
  // =========================================================================

  /**
   * Models surfaced in the picker. Two filters layered on `getAll()`:
   * 1. Provider must have *stored* credentials (OAuth or explicit `auth.json`
   *    API key). pi's `getAvailable()` would also include providers with
   *    matching env vars, but that leaks the user's shell environment and
   *    shows providers they never connected.
   * 2. Model id must be in `FEATURED_MODELS` for that provider. Pi exposes
   *    every model it knows about (~80 across our OAuth providers, including
   *    Claude 3 Opus from 2024); we only want current-generation flagships.
   *
   * Within each provider, results follow the order of `FEATURED_MODELS`
   * (best → fast/cheap), so the dropdown lands on a sensible default.
   */
  listAvailableModels(): ModelOption[] {
    const all = this.modelRegistry.getAll();
    const out: ModelOption[] = [];
    for (const provider of Object.keys(FEATURED_MODELS)) {
      if (!this.authStorage.getAuthStatus(provider).configured) continue;
      for (const id of FEATURED_MODELS[provider]) {
        const m = all.find((x) => x.provider === provider && x.id === id);
        if (!m) continue;
        out.push({
          key: `${m.provider}/${m.id}`,
          provider: m.provider,
          providerLabel: providerLabel(m.provider),
          modelId: m.id,
          label: m.name,
          costTier: MODEL_COST_TIER[m.id] ?? '$$',
        });
      }
    }
    // OpenRouter: surface every slug the user has explicitly saved. We
    // deliberately don't gate on whether an API key is present — adding a
    // slug is the explicit "I want this" signal, and if the key is missing
    // OpenRouter will return a clear error at first prompt.
    const { openrouterModels } = loadSettings();
    for (const slug of openrouterModels) {
      out.push({
        key: `${OPENROUTER_PROVIDER}/${slug}`,
        provider: OPENROUTER_PROVIDER,
        providerLabel: providerLabel(OPENROUTER_PROVIDER),
        modelId: slug,
        label: slug,
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // OpenRouter (BYO API key + arbitrary slugs)
  // ---------------------------------------------------------------------------

  getOpenRouterConfig(): OpenRouterConfig {
    return {
      apiKeyConfigured:
        this.authStorage.getAuthStatus(OPENROUTER_PROVIDER).source === 'stored',
      models: loadSettings().openrouterModels,
    };
  }

  /** Pass `null` to clear the stored key. */
  async setOpenRouterApiKey(key: string | null): Promise<OpenRouterConfig> {
    if (key && key.trim().length > 0) {
      this.authStorage.set(OPENROUTER_PROVIDER, {
        type: 'api_key',
        key: key.trim(),
      });
    } else {
      this.authStorage.remove(OPENROUTER_PROVIDER);
    }
    this.applyOpenRouterRegistration();
    this.emitOAuth({ type: 'links-changed' });
    await this.refreshActiveModel();
    return this.getOpenRouterConfig();
  }

  async addOpenRouterModel(slug: string): Promise<OpenRouterConfig> {
    const cleaned = slug.trim();
    if (!cleaned) return this.getOpenRouterConfig();
    const current = loadSettings().openrouterModels;
    if (current.includes(cleaned)) return this.getOpenRouterConfig();
    saveSettings({ openrouterModels: [...current, cleaned] });
    this.applyOpenRouterRegistration();
    this.emitOAuth({ type: 'links-changed' });
    return this.getOpenRouterConfig();
  }

  /**
   * Live context-window usage for the active session, if it matches the
   * given conversation. Returns null when no active session, the active
   * session is for a different conversation, or pi can't compute usage
   * (no model bound yet, fresh-after-compaction, etc.). Pi's value comes
   * from the most recent assistant `usage` plus an estimate of any newer
   * messages, so it updates per-turn without us having to count tokens.
   */
  getContextUsage(conversationId: string): ContextUsage | null {
    if (!this.active || this.active.conversationId !== conversationId) {
      return null;
    }
    return this.active.session.getContextUsage() ?? null;
  }

  /**
   * Fetch the user's live OpenRouter balance. Returns null when no API key
   * is configured. Errors propagate so the renderer can decide whether to
   * surface or swallow them.
   */
  async getOpenRouterCredits(): Promise<OpenRouterCredits | null> {
    const cred = this.authStorage.get(OPENROUTER_PROVIDER);
    const apiKey =
      cred?.type === 'api_key' ? cred.key : process.env.OPENROUTER_API_KEY;
    if (!apiKey) return null;
    return fetchOpenRouterCredits(apiKey);
  }

  async removeOpenRouterModel(slug: string): Promise<OpenRouterConfig> {
    const current = loadSettings().openrouterModels;
    const next = current.filter((s) => s !== slug);
    if (next.length === current.length) return this.getOpenRouterConfig();
    saveSettings({ openrouterModels: next });
    this.applyOpenRouterRegistration();
    this.emitOAuth({ type: 'links-changed' });
    await this.refreshActiveModel();
    return this.getOpenRouterConfig();
  }

  /** Provider catalog merged with current link status, for the settings UI. */
  listOAuthLinks(): OAuthLink[] {
    return this.authStorage.getOAuthProviders().map((p) => {
      const status = this.authStorage.getAuthStatus(p.id);
      return {
        id: p.id,
        name: p.name,
        label: providerLabel(p.id),
        linked: status.configured,
        source: status.source,
        usesCallbackServer: p.usesCallbackServer ?? false,
      };
    });
  }

  async loginOAuth(providerId: string): Promise<void> {
    // Single-flight: abort any prior attempt before starting.
    this.cancelOAuthLogin();

    const abort = new AbortController();
    this.pendingOAuth = {
      providerId,
      abort,
      resolvePrompt: null,
      rejectPrompt: null,
    };

    this.emitOAuth({ type: 'login-start', providerId });

    try {
      await this.authStorage.login(providerId as OAuthProviderId, {
        signal: abort.signal,
        onAuth: (info: OAuthAuthInfo) => {
          void shell.openExternal(info.url);
          this.emitOAuth({
            type: 'login-progress',
            providerId,
            message: 'Opening your browser to sign in…',
            authInfo: { url: info.url, instructions: info.instructions },
          });
        },
        onProgress: (message: string) => {
          this.emitOAuth({ type: 'login-progress', providerId, message });
        },
        onPrompt: (prompt: OAuthPrompt) => this.awaitPrompt(providerId, prompt),
        onManualCodeInput: () =>
          this.awaitPrompt(providerId, {
            message: 'Paste the authorization code from your browser:',
            placeholder: 'Authorization code',
          }),
      });
      this.emitOAuth({ type: 'login-success', providerId });
      this.emitOAuth({ type: 'links-changed' });
      await this.refreshActiveModel();
    } catch (err) {
      if (abort.signal.aborted) {
        this.emitOAuth({ type: 'login-cancelled', providerId });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.emitOAuth({ type: 'login-error', providerId, message });
      }
    } finally {
      if (this.pendingOAuth?.abort === abort) {
        this.pendingOAuth = null;
      }
    }
  }

  cancelOAuthLogin(): void {
    if (!this.pendingOAuth) return;
    const pending = this.pendingOAuth;
    pending.abort.abort();
    pending.rejectPrompt?.(new Error('aborted'));
    pending.resolvePrompt = null;
    pending.rejectPrompt = null;
  }

  /**
   * Renderer-side reply to a `prompt-needed` event. Resolves the awaited
   * `Promise<string>` inside the pi-ai login flow.
   */
  provideOAuthCode(providerId: string, value: string): void {
    if (
      !this.pendingOAuth ||
      this.pendingOAuth.providerId !== providerId ||
      !this.pendingOAuth.resolvePrompt
    ) {
      return;
    }
    const resolver = this.pendingOAuth.resolvePrompt;
    this.pendingOAuth.resolvePrompt = null;
    this.pendingOAuth.rejectPrompt = null;
    resolver(value);
  }

  async logoutOAuth(providerId: string): Promise<void> {
    this.authStorage.logout(providerId);
    this.emitOAuth({ type: 'logout', providerId });
    this.emitOAuth({ type: 'links-changed' });
    await this.refreshActiveModel();
  }

  private awaitPrompt(
    providerId: string,
    prompt: OAuthPrompt,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (!this.pendingOAuth || this.pendingOAuth.providerId !== providerId) {
        reject(new Error('No active login for this provider.'));
        return;
      }
      this.pendingOAuth.resolvePrompt = resolve;
      this.pendingOAuth.rejectPrompt = reject;
      this.emitOAuth({
        type: 'prompt-needed',
        providerId,
        message: prompt.message,
        placeholder: prompt.placeholder,
        allowEmpty: prompt.allowEmpty,
      });
    });
  }

  private emitOAuth(event: OAuthEvent): void {
    this.sendToRenderer('modmixer:oauth:event', event);
  }

  // =========================================================================
  // Background log monitoring (drives the test-in-game flow)
  // =========================================================================

  startLogMonitoring(conversationId: string): void {
    this.stopLogMonitoring();
    this.monitoringConversationId = conversationId;
    const watcher = getLogWatcher();
    this.logUnsubscribe = watcher.subscribe((groups) => {
      void this.handleLogErrors(groups, conversationId);
    });
    this.rimworldPollTimer = setInterval(() => {
      void this.checkRimWorldStillRunning();
    }, RIMWORLD_POLL_INTERVAL_MS);
    sendToast('Modmixer', 'Watching Player.log — go test the mod.');
    this.heartbeatTimer = setInterval(() => {
      sendToast('Modmixer', 'So far so good — no errors yet.', {
        silent: true,
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopLogMonitoring(): void {
    this.logUnsubscribe?.();
    this.logUnsubscribe = null;
    if (this.rimworldPollTimer) {
      clearInterval(this.rimworldPollTimer);
      this.rimworldPollTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.monitoringConversationId = null;
  }

  private async checkRimWorldStillRunning(): Promise<void> {
    if (!this.monitoringConversationId) return;
    if (!(await isRimWorldRunning())) {
      sendToast('Modmixer', 'RimWorld closed — test session ended.');
      this.stopLogMonitoring();
    }
  }

  private async handleLogErrors(
    groups: LogErrorGroup[],
    conversationId: string,
  ): Promise<void> {
    if (groups.length === 0) return;
    if (this.monitoringConversationId !== conversationId) return;
    // Don't stop monitoring — the watcher batches across the deadline window
    // and re-arms automatically. If a second cascade fires later in the same
    // test session, we want to catch it without the agent re-calling
    // watch_player_log.
    if (this.active?.conversationId !== conversationId) return;

    const total = groups.reduce((acc, g) => acc + g.count, 0);
    const errorWord = total === 1 ? 'error' : 'errors';
    sendToast(
      'Modmixer',
      `Caught ${total} ${errorWord} (${groups.length} unique) — investigating…`,
    );

    try {
      const session = this.active.session;
      // session.prompt() picks the right path automatically (queues via steer
      // if a turn is already in flight, otherwise starts a new turn). The
      // triage rubric for interpreting this summary lives in the system
      // prompt — only the dynamic summary lands in the chat.
      await session.prompt(formatErrorSummary(groups), {
        streamingBehavior: 'steer',
      });
    } catch (err) {
      console.error('Failed to prompt session with log errors:', err);
    }
  }

  async shutdown(): Promise<void> {
    this.stopLogMonitoring();
    await this.disposeActive();
  }
}
