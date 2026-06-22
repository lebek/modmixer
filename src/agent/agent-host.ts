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
import {
  complete,
  type Api,
  type ImageContent,
  type Model,
  type OAuthAuthInfo,
  type OAuthPrompt,
  type OAuthProviderId,
} from '@mariozechner/pi-ai';
import type {
  AgentMessage,
  AgentTool,
  ThinkingLevel,
} from '@mariozechner/pi-agent-core';
import {
  ErrorBuffer,
  formatErrorSummary,
  type ErrorBufferGroup,
} from './monitor/error-buffer.js';
import { getMonitorServer } from './monitor/server.js';
import type { MonitorConnectionState } from './monitor/protocol.js';
import { getLiveServer } from './live/server.js';
import { currentLiveInstallEpoch, removeLiveInstall } from './live/install.js';
import type {
  LiveConnectionState,
  LiveUserPrompt,
} from './live/protocol.js';
import { createApplyLiveTool } from './tools/apply-live.js';
import { createGameActionTool } from './tools/game-action.js';
import { getWorkspaceMod } from './workspace.js';
import { BRIDGE_PACKAGE_ID, removeBridgeInstall } from './bridge-install.js';
import { getRegistry } from './registry/index.js';
import { createScaffoldModTool } from './tools/scaffold-mod.js';
import { setModMetadataTool } from './tools/set-mod-metadata.js';
import { updateSchematicTool } from './tools/update-schematic.js';
import { buildModTool } from './tools/build-mod.js';
import { monitorGetErrorTool } from './tools/monitor-get-error.js';
import { monitorPollTool } from './tools/monitor-poll.js';
import { listInstalledModsTool } from './tools/list-installed-mods.js';
import { decompileDllTool } from './tools/decompile-dll.js';
import { renderSvgToPngTool } from './tools/render-svg-to-png.js';
import { renderPreviewTool } from './tools/render-preview.js';
import { searchDefsTool } from './tools/search-defs.js';
import { createReadCsharpSymbolTool } from './tools/read-csharp-symbol.js';
import { createSearchSourceTool } from './tools/search-source.js';
import { warmSearchCache } from './index/warm-cache.js';
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
import { withConfirmation } from './security/with-confirmation.js';
import { SafeStorageAuthBackend } from './security/secure-auth-storage.js';
import { createRunTestCycleTool } from './tools/run-test-cycle.js';
import { notifyTestStatusTool } from './tools/notify-test-status.js';
import { sendToast } from './notifications.js';
import { loadSettings, saveSettings } from './settings.js';
import {
  fetchOpenRouterCatalog,
  getCachedOpenRouterPricing,
  getCachedOpenRouterInputs,
  isOpenRouterCatalogStale,
  type OpenRouterCost,
} from './openrouter-catalog.js';
import {
  fetchOpenRouterCredits,
  type OpenRouterCredits,
} from './openrouter-credits.js';
import { getWorkspacePaths } from './workspace.js';
import { ScopedResourceLoader } from './resource-loader.js';
import { buildStripThinkingExtension } from './strip-thinking-extension.js';
import { buildSnapshotExtension } from './snapshot-extension.js';
import {
  commitTurn,
  restoreSnapshot,
  type SaveRecord,
} from './snapshots.js';
import { buildSystemPrompt } from './system-prompt.js';
import { readModPrefs } from './mod-prefs.js';
import type { GameId } from './games/types.js';
import { ensureMinecraftIndexInBackground } from './index/rebuild-minecraft.js';
import type { Extension } from '@mariozechner/pi-coding-agent';
import {
  addAttachmentPaths,
  addConversation,
  getConversation,
  isDefaultTitle,
  removeConversation,
  setActiveForMod,
  setConvModel,
  setConvThinkingLevel,
  setScope,
  setSystemPrompt,
  setTitle,
  touch,
  type Conversation,
  type ConversationScope,
} from './conversations.js';
import { messageText } from '../lib/agent-utils.js';
import { readImageContentForModel } from './attachments/prepare.js';
import type { PreparedAttachment } from './attachments/types.js';
import type { ModelOption } from './models.js';
import type { LocalProvider, ModelSelection } from './settings.js';
import { randomUUID } from 'node:crypto';

const HEARTBEAT_INTERVAL_MS = 60_000;

// Stable substring used to detect a previously-injected recovery prompt when
// walking back through history (so we never recover the same user turn
// twice). Keep this prefix verbatim if you reword the user-visible message.
const TRUNCATION_RECOVERY_SENTINEL_TAG = '[automated — truncation recovery]';
const TRUNCATION_RECOVERY_PROMPT =
  `${TRUNCATION_RECOVERY_SENTINEL_TAG} Your previous turn produced reasoning but no visible reply or tool call (the response was likely truncated mid-thought by the output-token budget). Continue from where you left off and produce a concise final answer or call a tool — don't restart your reasoning from scratch.`;

/**
 * Mod-mixer-specific tools, plus a path-policy-guarded `bash` that overrides
 * pi's built-in (custom tools win by name in `_refreshToolRegistry`). The
 * bash tool is constructed with a cwd, so it lives inside the host instead
 * of at module scope.
 */
// Exported so the headless verification harness (scripts/harness/) can build
// the EXACT same tool set the live app uses, then wrap the side-effecting
// ones with stubs. Keep this the single source of truth for the tool list —
// the harness reuses it rather than maintaining a parallel copy that drifts.
export function buildCustomTools(
  cwd: string,
  conversationId: string,
  getActiveScope: () => ConversationScope | null,
  getActiveModel: () => Model<Api> | null,
  getAttachmentRoots: () => string[],
  opts?: { live?: boolean; game?: GameId },
): AgentTool<any>[] {
  const game = opts?.game ?? 'rimworld';
  // Guarded path tools are common to both modes.
  const pathTools: AgentTool<any>[] = [
    // Override pi's path-shaped built-ins with versions that enforce the
    // allowlist. Custom tools win over built-ins by name in pi's
    // `_refreshToolRegistry`, so these shadow the defaults entirely.
    // read/grep/find/ls also accept chat-attached files & directories the
    // user dragged in — see `getAttachmentRoots`. write/edit deliberately do
    // not: the agent copies attachments *into* the mod, never writes back out.
    createGuardedReadTool(cwd, getActiveModel, getAttachmentRoots),
    createGuardedWriteTool(cwd),
    createGuardedEditTool(cwd),
    createGuardedGrepTool(cwd, getAttachmentRoots),
    createGuardedFindTool(cwd, getAttachmentRoots),
    createGuardedLsTool(cwd, getAttachmentRoots),
  ];
  // Read-only research tools. The source-index lookups are game-aware; the
  // RimWorld-specific ones (installed-mods, .NET decompile, XML def search) are
  // omitted for Minecraft, whose data/JSON index isn't wired yet.
  const researchTools: AgentTool<any>[] =
    game === 'minecraft'
      ? [
          createReadCsharpSymbolTool(game),
          createSearchSourceTool(game),
          readLoreTool,
          saveLoreTool,
        ]
      : [
          listInstalledModsTool,
          decompileDllTool,
          // RimWorld source/def index — read-only lookups against $MM/index/*.
          searchDefsTool,
          createReadCsharpSymbolTool(game),
          createSearchSourceTool(game),
          readLoreTool,
          saveLoreTool,
        ];

  if (opts?.live) {
    // Live sessions: the user is in-game and cannot answer app dialogs, so
    // every tool here must run without a confirmation prompt — which is why
    // bash (confirmation-gated) is absent, not just discouraged. No
    // run_test_cycle either: the game is already running, and apply_live /
    // game_action are how changes reach it. Texture tools are out until
    // live content reload exists.
    return [
      setModMetadataTool,
      updateSchematicTool,
      buildModTool,
      createApplyLiveTool(conversationId, getActiveScope),
      createGameActionTool(getActiveScope),
      monitorGetErrorTool,
      monitorPollTool,
      ...researchTools,
      ...pathTools,
    ];
  }

  return [
    createScaffoldModTool(getActiveScope),
    setModMetadataTool,
    updateSchematicTool,
    buildModTool,
    createRunTestCycleTool(conversationId),
    notifyTestStatusTool,
    monitorGetErrorTool,
    monitorPollTool,
    renderSvgToPngTool,
    renderPreviewTool,
    ...researchTools,
    // bash is the catch-all for arbitrary shell exec. The path-policy guard
    // is the safety net; the confirmation prompt is the user-facing brake.
    withConfirmation(createGuardedBashTool(cwd), {
      label: 'Run shell command',
      summary: 'Execute a shell command in the modmixer workspace.',
    }, (p: { command: string }) => `Run “${p.command.length > 120 ? p.command.slice(0, 119) + '…' : p.command}” in the modmixer workspace.`),
    ...pathTools,
  ];
}

/**
 * Fold chat attachments into a prompt: register their paths on the session's
 * read-side allowlist, append a path manifest the agent can act on, and —
 * when the model has vision — read image files into content blocks. The
 * files on disk are untouched; the downscaled JPEG blocks are only the
 * model's view, so the agent still copies full-quality sources into the mod.
 */
async function buildAttachedPrompt(
  entry: OpenSession,
  text: string,
  attachments: PreparedAttachment[] | undefined,
): Promise<{ promptText: string; images: ImageContent[] | undefined }> {
  if (!attachments || attachments.length === 0) {
    return { promptText: text, images: undefined };
  }
  for (const a of attachments) entry.attachmentRoots.add(a.path);
  // Persist the paths so the allowlist survives session reconstruction and
  // app restart — the agent can act on the attachment in a later turn.
  addAttachmentPaths(
    entry.conversationId,
    attachments.map((a) => a.path),
  );

  const lines = attachments.map(
    (a) => `- ${a.path}${a.isDirectory ? '  (directory)' : ''}`,
  );
  const manifest =
    '[Files attached by the user — read, inspect, or copy them into the ' +
    'mod as the request needs:]\n' +
    lines.join('\n');
  const promptText = text.trim() ? `${text}\n\n${manifest}` : manifest;

  const model = entry.session.model;
  const images: ImageContent[] = [];
  if (model && model.input.includes('image')) {
    for (const a of attachments) {
      if (!a.isImage || a.isDirectory) continue;
      const img = await readImageContentForModel(a.path);
      if (img) images.push(img);
    }
  }
  return { promptText, images: images.length ? images : undefined };
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

/**
 * Prefix used for user-defined local OpenAI-compatible providers (LM Studio,
 * Ollama, vLLM, llama.cpp, …). Each entry is registered with pi as
 * `${LOCAL_PROVIDER_PREFIX}${id}` so multiple local servers coexist in the
 * model picker.
 */
const LOCAL_PROVIDER_PREFIX = 'local:';

function localProviderName(id: string): string {
  return `${LOCAL_PROVIDER_PREFIX}${id}`;
}

/**
 * Placeholder API key sent to local servers that don't actually authenticate
 * (LM Studio, Ollama, llama.cpp). Pi's registerProvider() rejects empty
 * apiKey when models are defined, but the OpenAI SDK forwards whatever
 * string we pass — these servers don't care what's there.
 */
const LOCAL_PROVIDER_PLACEHOLDER_KEY = 'local-llm';

/**
 * OpenRouter slugs that are always present, regardless of what the user has
 * saved. Pinned slugs are merged into the runtime model list (and shown in
 * the settings UI as locked entries with a Recommended tag), but never
 * persisted to settings.json — so updating this list rolls out to existing
 * users automatically. `removeOpenRouterModel` rejects these slugs.
 */
const PINNED_OR_MODELS = ['moonshotai/kimi-k2.6'];

function isPinnedOpenRouterSlug(slug: string): boolean {
  return PINNED_OR_MODELS.includes(slug);
}

/**
 * Slugs we know support reasoning/thinking. Whitelisted by family prefix so
 * future minor releases (kimi-k2.7, deepseek-v4.1, etc.) inherit automatically.
 * Anything not on this list falls back to reasoning=false — pi clamps the
 * thinking-level dropdown to "off" for those, which matches their actual
 * behavior on OpenRouter.
 */
const REASONING_PREFIXES = [
  'moonshotai/kimi-k2',
  'deepseek/deepseek-v4',
  'deepseek/deepseek-v3.2',
  'qwen/qwen3',
  'anthropic/claude',
  'openai/o1',
  'openai/o3',
  'openai/o4',
  'openai/gpt-5',
  'google/gemini-2.5',
  'google/gemini-3',
  'x-ai/grok-4',
  'z-ai/glm-4.6',
];

function slugSupportsReasoning(slug: string): boolean {
  return REASONING_PREFIXES.some((prefix) => slug.startsWith(prefix));
}

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * Per-provider curation: pi-ai knows about ~80 models across our supported
 * OAuth providers (claude-3-haiku from 2024, gpt-4-turbo, etc.) — most aren't
 * what someone picking "an AI to write RimWorld mods" wants. The picker shows
 * only the IDs listed here. Update when new flagships ship.
 *
 * `claude-fable-5` and `claude-opus-4-8` aren't in our pinned pi-ai catalog
 * yet (newest built-in is 4-7), so they're bridged in via BRIDGE_MODELS /
 * seedBridgeModels() below. Drop a bridge once pi-ai ships the built-in entry.
 */
const FEATURED_MODELS: Record<string, string[]> = {
  anthropic: [
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ],
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
  openrouter: 'moonshotai/kimi-k2.6',
};

/**
 * Rough cost band shown next to each model in the picker. '$' = cheap/fast,
 * '$$' = mid (Sonnet-tier), '$$$' = flagship. These are coarse buckets, not
 * exact pricing — the goal is to help the user avoid accidentally selecting
 * the most expensive option.
 */
const MODEL_COST_TIER: Record<string, '$' | '$$' | '$$$'> = {
  // Anthropic
  'claude-fable-5': '$$$',
  'claude-opus-4-8': '$$$',
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

/**
 * Models we surface before pi-ai's catalog ships a built-in entry for them.
 * ModelRegistry merges custom models from models.json by provider+id (custom
 * wins, built-ins otherwise preserved), so seeding here adds the model without
 * touching Anthropic's built-in models or its Pro/Max OAuth wiring — which a
 * `registerProvider('anthropic', …)` call would wipe (full replacement).
 *
 * Specs verified against Anthropic's docs (May 2026): claude-opus-4-8 matches
 * 4.7 — 1M-token context (no beta header), 128k max output, adaptive thinking,
 * vision, $5/$25 per Mtok with 90% cache-read / 1.25x cache-write. `api` and
 * `baseUrl` are omitted: for a built-in provider, parseModels() inherits them
 * from the provider's built-in defaults (anthropic-messages, api.anthropic.com).
 *
 * claude-fable-5 specs match upstream pi's generated catalog (earendil-works/pi
 * commit 66f432c, June 2026): same API surface as Opus 4.7/4.8 plus one new
 * constraint — an explicit `thinking: {type: "disabled"}` is a 400; the param
 * must be omitted when thinking is off.
 *
 * ADAPTIVE-THINKING PATCH (patches/@mariozechner+pi-ai+0.70.6.patch): pinned
 * pi-ai 0.70.6 decides adaptive vs. budget thinking by a hardcoded model-id
 * substring list (opus-4-6/4-7, sonnet-4-6) and ignores the
 * `compat.forceAdaptiveThinking` flag that upstream added in 0.75.5 — so the
 * flag is omitted above (it would be a no-op). Neither bridge model is in
 * that list, so without the patch both fall back to budget-based thinking,
 * which these models reject (`budget_tokens` is removed on 4.8/Fable;
 * observed on 4.8 as blank follow-up replies) plus the deprecated
 * interleaved-thinking beta header; fable-5 additionally 400s on the explicit
 * disabled-thinking param when thinking is off. The patch teaches
 * supportsAdaptiveThinking / mapThinkingLevelToEffort about opus-4-8 and
 * fable-5, and omits `thinking` for fable-5 when off. It is pinned to 0.70.6:
 * bumping pi-ai silently drops it (the version-stamped filename stops
 * matching), so re-cut it on any bump. At pi-ai >= 0.77.0 (rescoped to
 * @earendil-works) drop the patch and these bridge entries — both models are
 * built-ins there carrying forceAdaptiveThinking.
 *
 * Remove an entry once the pinned pi-ai release includes it as a built-in.
 */
const BRIDGE_MODELS: Record<string, Array<Record<string, unknown>>> = {
  anthropic: [
    {
      id: 'claude-fable-5',
      name: 'Claude Fable 5',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
    {
      id: 'claude-opus-4-8',
      name: 'Claude Opus 4.8',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
  ],
};

/**
 * Idempotently merge BRIDGE_MODELS into the user's models.json so the registry
 * picks them up on load/refresh. Only adds entries that are missing by
 * provider+id — never edits or removes anything the user (or pi's /models) put
 * there. Bad JSON is left untouched so we don't clobber user data; the registry
 * surfaces parse errors of its own accord.
 */
function seedBridgeModels(modelsJsonPath: string): void {
  try {
    let config: {
      providers?: Record<string, { models?: Array<{ id?: string }> }>;
    } = {};
    if (fs.existsSync(modelsJsonPath)) {
      try {
        config = JSON.parse(fs.readFileSync(modelsJsonPath, 'utf8'));
      } catch {
        // Malformed file — leave it for the user/registry to surface, don't
        // overwrite their content.
        return;
      }
    }
    const providers = (config.providers ??= {});
    let changed = false;
    for (const [provider, models] of Object.entries(BRIDGE_MODELS)) {
      const entry = (providers[provider] ??= {});
      const list = (entry.models ??= []);
      for (const model of models) {
        if (!list.some((m) => m.id === model.id)) {
          list.push(model as { id?: string });
          changed = true;
        }
      }
    }
    if (changed) {
      fs.mkdirSync(path.dirname(modelsJsonPath), { recursive: true });
      fs.writeFileSync(modelsJsonPath, JSON.stringify(config, null, 2));
    }
  } catch (err) {
    console.error('seedBridgeModels failed:', err);
  }
}

export interface OpenRouterConfig {
  /** True when an API key is persisted in encrypted AuthStorage. */
  apiKeyConfigured: boolean;
  /**
   * All slugs that should be rendered as picker entries — pinned (always-on)
   * slugs first, then user-added slugs. Pinned slugs are not persisted, so
   * adding a new pinned slug rolls out to existing users automatically.
   */
  models: string[];
  /**
   * Subset of `models` that the user can't remove (shown in the settings UI
   * with a Recommended tag and no Remove button).
   */
  pinnedModels: string[];
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
export function toolDefinitionFromAgentTool(
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

interface OpenSession {
  conversationId: string;
  scope: ConversationScope;
  session: AgentSession;
  unsubscribe: () => void;
  /**
   * Set when an in-flight tool call (currently only scaffold_mod) upgrades
   * this conversation's scope. The next send() for this conversation
   * reconstructs the AgentSession against the new scope before prompting,
   * so the user's next message hits a fresh system prompt without us
   * mutating one in flight.
   */
  pendingScopeReload: ConversationScope | null;
  /**
   * Absolute paths of files/directories the user attached to this chat.
   * Read-side guarded tools (read/grep/find/ls) treat these as extra
   * allowlist roots so the agent can inspect a dragged-in file or copy it
   * into the mod. Grows as the user attaches more across the session.
   */
  attachmentRoots: Set<string>;
}

export class AgentHost {
  private readonly getWindow: () => BrowserWindow | null;
  private readonly cwd: string;
  private readonly agentDir: string;
  private readonly sessionDir: string;
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly settingsManager: SettingsManager;
  private readonly allowedToolNames: string[];

  /**
   * One entry per open conversation (one mod tab in the UI). Sessions run
   * independently — a turn in flight for one mod doesn't block another, and
   * a turn keeps streaming while the user is focused on a different tab.
   */
  private sessions = new Map<string, OpenSession>();
  /**
   * In-flight session constructions. Two concurrent openSession calls for the
   * same conversation (a fast double-click, or send() racing the background
   * open) share one construction instead of leaking a second session.
   */
  private constructing = new Map<string, Promise<OpenSession>>();
  /**
   * Conversations with a turn in flight, tracked from agent_start/agent_end
   * events. `releaseIdleSession` consults this so the multi-chat UI can free
   * a switched-away session without aborting live work.
   */
  private busyConversations = new Set<string>();
  /**
   * Built lazily once on first session construction and reused thereafter.
   * The strip-thinking transform is stateless; one extension instance is
   * fine across every session in the app's lifetime.
   */
  private stripThinkingExtension: Extension | null = null;

  // Background bridge monitoring (test-in-game flow). Tied to a specific
  // conversation, dropped when the user switches away. The bridge mod
  // ships diagnostics over a localhost TCP socket; MonitorServer.on('state')
  // tells us when the in-game side connects and disconnects, replacing the
  // tasklist polling we used to do for Player.log-based watching.
  private errorBuffer: ErrorBuffer | null = null;
  private errorBufferDetach: (() => void) | null = null;
  private monitorStateHandler: ((s: MonitorConnectionState) => void) | null =
    null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private monitoringConversationId: string | null = null;
  /**
   * Whether the currently-monitored test session ran in isolated mode
   * (separate test-savedata ModsConfig.xml) vs against the user's real
   * <activeMods>. Drives teardown: non-isolated sessions strip
   * `modmixer.bridge` from <activeMods> on disconnect, isolated ones don't
   * touch the real config.
   */
  private monitoringIsolated = false;
  /**
   * Did we see a bridge_hello during this monitoring session? The
   * "test session ended" toast only fires after this flips true; otherwise
   * the user switching to a non-running game would immediately blow away
   * the freshly-armed monitoring. Reset on every startMonitoring.
   */
  private bridgeSeenConnected = false;
  /**
   * Has the buffer surfaced at least one error/warning batch since
   * monitoring started? Gates the periodic "so far so good" heartbeat
   * toast — once errors arrive, the reassurance is misleading.
   */
  private bridgeErrorsSeen = false;

  // Live session (in-game prompting over the Live TCP channel). Bound to
  // one conversation, like monitoring: prompts typed in the in-game window
  // route to that conversation, and its agent events are projected back as
  // agent_busy / agent_status / agent_say pushes. Singleton by the same
  // argument as monitoring — one game, one Live socket.
  private liveConversationId: string | null = null;
  private liveStateHandler: ((s: LiveConnectionState) => void) | null = null;
  private livePromptHandler: ((p: LiveUserPrompt) => void) | null = null;
  /** Same role as bridgeSeenConnected: teardown only fires after the game
   *  actually connected once, so arming a session against a not-yet-started
   *  game doesn't immediately tear itself down. */
  private liveSeenConnected = false;
  private liveInstallEpoch = 0;

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
    const modelsJsonPath = path.join(this.agentDir, 'models.json');
    seedBridgeModels(modelsJsonPath);
    this.modelRegistry = ModelRegistry.create(this.authStorage, modelsJsonPath);
    this.settingsManager = SettingsManager.create(this.cwd, this.agentDir);
    // ModMixer deliberately does not use the harness's app-level auto-retry.
    // A failed turn (e.g. an Anthropic 529 "overloaded") is surfaced in the
    // chat as an error row, and the user re-sends to retry. The auto-retry
    // loop is worse than that here: each failed attempt lands as a blank
    // assistant bubble, the backoff window has no Stop affordance to cancel
    // into, and a message sent mid-backoff races the scheduled continue().
    // The Anthropic SDK's own in-request retries stay on (configured
    // separately under retry.provider) — only this Layer-2 loop is disabled.
    // Guarded so we write settings.json at most once, not on every launch.
    if (this.settingsManager.getRetryEnabled()) {
      this.settingsManager.setRetryEnabled(false);
    }
    // Custom tools are rebuilt per session in constructSession — their
    // closures bind to one specific conversation's scope/model. Here we only
    // need the tool *names* for the allowlist, so throwaway builds with
    // no-op getters are enough. Union of both modes: the allowlist is
    // host-wide while the actual tool set is per-session, so live-only
    // names (apply_live, game_action) must be allowed even though regular
    // chats never construct them.
    const toolNames = new Set<string>();
    for (const live of [false, true]) {
      for (const t of buildCustomTools(
        this.cwd,
        '',
        () => null,
        () => null,
        () => [],
        { live },
      )) {
        if (!BUILTIN_TOOL_NAMES.includes(t.name)) toolNames.add(t.name);
      }
    }
    this.allowedToolNames = [...BUILTIN_TOOL_NAMES, ...toolNames];
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
      this.applyLocalProvidersRegistration();
    } catch (err) {
      console.error('AgentHost.primeAfterReady failed:', err);
    }
    // Best-effort catalogue prime: the cached pricing/modality maps are
    // consulted by the registration above. If the cache is empty or stale,
    // refresh in the background and re-register so subsequent turns pick up
    // real rates and accurate image support.
    if (isOpenRouterCatalogStale()) {
      void fetchOpenRouterCatalog()
        .then(() => {
          try {
            this.applyOpenRouterRegistration();
          } catch (err) {
            console.error(
              'AgentHost: failed to re-register openrouter after catalogue fetch:',
              err,
            );
          }
        })
        .catch(() => {
          // Catalogue fetch is best-effort — failures just leave $0 rates and
          // text-only input in place until the next launch.
        });
    }
  }

  /**
   * Register the user's saved OpenRouter slugs as runtime models in pi's
   * registry. Pi's built-in openrouter catalog includes ~300 entries, but
   * the picker only surfaces what the user has explicitly saved here —
   * registering replaces those built-ins with our short list. Per-million
   * token rates and image support are pulled from the cached OpenRouter
   * catalogue (see `openrouter-catalog.ts`); slugs missing from the cache
   * fall back to $0 rates and text-only input until the next refresh lands.
   */
  /**
   * Effective slug list: pinned (always-on, never persisted) slugs first,
   * then user-added slugs from settings. Deduped so a user who already had
   * a pinned slug in their persisted list doesn't see it twice.
   */
  private getEffectiveOpenRouterModels(): string[] {
    const { openrouterModels } = loadSettings();
    const seen = new Set<string>();
    const out: string[] = [];
    for (const slug of [...PINNED_OR_MODELS, ...openrouterModels]) {
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(slug);
    }
    return out;
  }

  private applyOpenRouterRegistration(): void {
    const openrouterModels = this.getEffectiveOpenRouterModels();
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
    const inputs = getCachedOpenRouterInputs() ?? {};
    const zero: OpenRouterCost = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    const pricingFor = (slug: string): OpenRouterCost => pricing[slug] ?? zero;
    // Image support comes straight from the catalogue's `input_modalities`.
    // Slugs missing from the cache fall back to text-only — the safe default,
    // since the read tool strips images for non-vision models.
    const inputFor = (slug: string): ('text' | 'image')[] =>
      inputs[slug] ?? ['text'];
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
        // pi-coding-agent gates the thinking-level dropdown off `reasoning`:
        // when false, getAvailableThinkingLevels() returns ["off"] and any
        // user-selected level (high, xhigh, …) silently clamps to "off". For
        // known reasoning families we flip this on so the saved preference
        // actually flows through.
        reasoning: slugSupportsReasoning(slug),
        input: inputFor(slug),
        cost: pricingFor(slug),
        // 200k is a safe upper bound for "modern" OpenRouter models; the
        // actual limit is enforced server-side regardless of what we say.
        contextWindow: 200_000,
        // 32k output cap. Reasoning models (Kimi K2.6 xhigh, DeepSeek R1, etc.)
        // emit reasoning_content into the same output budget as the visible
        // reply, and at xhigh the trace alone can run 8–20k tokens. With the
        // old 8192 cap, long traces exhausted the budget mid-thought and the
        // turn ended with reasoning-only content (Moonshot reports that as
        // finish_reason=stop, not length, so the agent loop terminates as if
        // the model said "ok" — user sees a blank reply). 32k leaves headroom
        // for the reasoning trace plus a real answer.
        maxTokens: 32_768,
        // Kimi K2 emits tool calls in its native `<|tool_call_begin|>` format
        // that requires the `kimi_k2` parser; not every OpenRouter sub-provider
        // ships it, so pin to Moonshot's own infra to avoid raw tokens leaking
        // into tool-call args.
        //
        // supportsDeveloperRole:false — pi promotes the system prompt to the
        // `developer` role for reasoning models, but Moonshot's own K2.6
        // endpoint can't tokenize that role and rejects the whole request with
        // "tokenization failed". Force the plain `system` role instead.
        //
        // requiresReasoningContentOnAssistantMessages:true — with thinking on,
        // Moonshot rejects any follow-up turn whose prior assistant tool-call
        // message lacks `reasoning_content` ("thinking is enabled but
        // reasoning_content is missing..."). This flag makes pi stamp it (empty
        // string is accepted), so multi-turn tool use works. Defaults true only
        // for DeepSeek upstream; Kimi needs it too.
        ...(slug.startsWith('moonshotai/kimi-k2')
          ? {
              compat: {
                openRouterRouting: { only: ['moonshotai'] },
                supportsDeveloperRole: false,
                requiresReasoningContentOnAssistantMessages: true,
              },
            }
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

  /**
   * Tear down one open session. Used on tab close, chat reset, and app exit.
   * No-op when the conversation has no open session.
   */
  private async disposeSession(conversationId: string): Promise<void> {
    const entry = this.sessions.get(conversationId);
    if (!entry) return;
    this.sessions.delete(conversationId);
    this.busyConversations.delete(conversationId);
    try {
      await entry.session.abort();
    } catch (err) {
      console.error('AgentSession.abort failed:', err);
    }
    entry.unsubscribe();
    try {
      entry.session.dispose();
    } catch (err) {
      console.error('AgentSession.dispose failed:', err);
    }
  }

  /**
   * Build a fresh AgentSession bound to the given conversation. The
   * conversation's session file is loaded if it exists; otherwise a new
   * empty session file is created.
   */
  /**
   * Resolve a model selection to an actual pi-ai Model object. Tries, in
   * order: `preferred` (a conversation's own per-chat pick), then the
   * settings default, then the first OAuth-available model, then any
   * built-in model. Each candidate is skipped if its provider isn't authed.
   * The session still constructs in the no-auth case so the UI can hydrate;
   * send() will fail at prompt time, but the chat panel gates that path.
   */
  private resolveModel(preferred?: ModelSelection | null): Model<Api> | null {
    for (const sel of [preferred, loadSettings().model]) {
      if (!sel) continue;
      const found = this.modelRegistry.find(sel.provider, sel.modelId);
      if (found && this.modelRegistry.hasConfiguredAuth(found)) return found;
    }
    // No usable preferred/saved selection — prefer the Sonnet-tier default of
    // the first linked provider over "first model registered," so a fresh
    // install lands on a sensible mid-tier model instead of whatever sorts
    // first.
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
  ): Promise<OpenSession> {
    // A chat is about to start issuing tool calls — pre-warm the source/defs
    // corpus so the first search_source isn't a ~40s cold-cache hit. Fire and
    // forget; the cooldown inside makes repeat calls free.
    void warmSearchCache('session-open');
    const model = this.resolveModel(convo.model);
    if (!model) {
      throw new Error('No models registered in pi-ai — cannot construct session.');
    }
    // Backfill this chat's own model pick if it had none — a legacy chat, or
    // one created before any provider was connected. Keeps the in-chat picker
    // and the running session agreeing on what model is in use.
    if (!convo.model) {
      setConvModel(convo.id, { provider: model.provider, modelId: model.id });
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
      systemPrompt = buildSystemPrompt(convo.scope, { game: convo.game });
      setSystemPrompt(convo.id, systemPrompt);
    }
    if (!this.stripThinkingExtension) {
      // Stateless transform — one instance services every session.
      this.stripThinkingExtension = buildStripThinkingExtension();
    }
    // Per-session: the snapshot extension's agent_end handler closes over
    // the mod folder, so it has to be rebuilt whenever scope changes
    // (scope upgrade after scaffold_mod). Returns null for "new"-scope
    // chats with no folder yet.
    const snapshotFolder =
      convo.scope.type === 'mod' ? convo.scope.modFolder : null;
    const snapshotExtension = buildSnapshotExtension({
      folder: snapshotFolder,
    });
    const extensions: Extension[] = [this.stripThinkingExtension];
    if (snapshotExtension) extensions.push(snapshotExtension);
    const resourceLoader = new ScopedResourceLoader(systemPrompt, extensions);

    // Per-chat reasoning effort; backfilled for legacy chats like the model.
    const thinkingLevel = convo.thinkingLevel ?? loadSettings().thinkingLevel;
    if (convo.thinkingLevel === undefined) {
      setConvThinkingLevel(convo.id, thinkingLevel);
    }
    // Per-session custom tools: each tool's closures bind to THIS
    // conversation, so a tool call in one mod's chat can never read another
    // mod's scope or model. `sessionRef` is filled in immediately after
    // construction; tools only execute during prompt(), long after.
    let sessionRef: AgentSession | null = null;
    // Per-session allowlist of chat-attached files; the guarded read tools
    // close over this getter so attachments added later in the chat are
    // visible without rebuilding the session. Seeded from the persisted
    // list so attachments survive reconstruction and app restart.
    const attachmentRoots = new Set<string>(convo.attachmentPaths ?? []);
    // A Minecraft conversation kicks off its source-index build now so it's
    // ready (or warm) by the time the agent searches; the build dedups and is
    // a no-op once fresh. RimWorld uses the startup/settings trigger instead.
    if (convo.game === 'minecraft') ensureMinecraftIndexInBackground();
    const customTools = buildCustomTools(
      this.cwd,
      convo.id,
      () => convo.scope,
      () => sessionRef?.model ?? null,
      () => [...attachmentRoots],
      { live: convo.live === true, game: convo.game },
    ).map((tool) => toolDefinitionFromAgentTool(tool));
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
      customTools,
    });
    sessionRef = session;

    const unsubscribe = session.subscribe((event) =>
      this.onSessionEvent(convo.id, event),
    );

    return {
      conversationId: convo.id,
      scope: convo.scope,
      session,
      unsubscribe,
      pendingScopeReload: null,
      attachmentRoots,
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

  /**
   * Detect "the model produced reasoning but no visible reply" and inject a
   * synthetic follow-up nudging it to actually answer.
   *
   * Why: reasoning models (Kimi K2.6 xhigh, etc.) emit reasoning_content into
   * the same output budget as the visible reply. When the reasoning trace
   * fills the budget, the response ends with thinking-only content. Moonshot
   * via OpenRouter reports finish_reason=stop in this case (not length), so
   * the agent loop terminates as if the model said "ok" and the user sees a
   * blank bubble. With maxTokens raised this should be rare, but it can also
   * happen when the model genuinely exits inside a reasoning loop without
   * converging on an answer.
   *
   * Loop guard: walk back to the most recent user message before this turn.
   * If that message is one of our sentinels, we already injected a recovery
   * for this user prompt — give up rather than spinning.
   */
  private maybeRecoverFromTruncatedReply(
    conversationId: string,
    message: AgentMessage,
  ): void {
    const entry = this.sessions.get(conversationId);
    if (!entry) return;
    if (message.role !== 'assistant') return;
    if (message.stopReason !== 'stop' && message.stopReason !== 'length') {
      return;
    }
    if (!Array.isArray(message.content)) return;

    let hasThinking = false;
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim().length > 0) return;
      if (block.type === 'toolCall') return;
      if (block.type === 'thinking') hasThinking = true;
    }
    if (!hasThinking) return;

    const messages = entry.session.agent.state.messages;
    for (let i = messages.length - 2; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== 'user') continue;
      if (messageText(m).includes(TRUNCATION_RECOVERY_SENTINEL_TAG)) return;
      break;
    }

    void entry.session
      .prompt(TRUNCATION_RECOVERY_PROMPT, { streamingBehavior: 'steer' })
      .catch((err) => {
        console.error('Failed to inject truncation recovery prompt:', err);
      });
  }

  private onSessionEvent(
    conversationId: string,
    event: AgentSessionEvent,
  ): void {
    this.sendToRenderer('modmixer:agent:event', {
      conversationId,
      event,
    });

    // Mirror a live conversation's progress into the in-game window.
    this.relayLiveEvent(conversationId, event);

    if (event.type === 'agent_start') {
      this.busyConversations.add(conversationId);
    } else if (event.type === 'agent_end') {
      this.busyConversations.delete(conversationId);
    }

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

    if (event.type === 'turn_end') {
      this.maybeRecoverFromTruncatedReply(conversationId, event.message);
    }

    // When scaffold_mod succeeds inside a "new" scope, upgrade the
    // conversation scope so future turns get a mod-scoped system prompt. We
    // can't swap the running session's prompt safely mid-turn, so we mark a
    // scope reload — the next send() will dispose and reconstruct against
    // the new scope.
    const scaffoldEntry = this.sessions.get(conversationId);
    if (
      event.type === 'tool_execution_end' &&
      event.toolName === 'scaffold_mod' &&
      !event.isError &&
      scaffoldEntry &&
      scaffoldEntry.scope.type === 'new'
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
        setSystemPrompt(
          conversationId,
          buildSystemPrompt(nextScope, {
            game: getConversation(conversationId)?.game,
          }),
        );
        setActiveForMod(folder, conversationId);
        scaffoldEntry.pendingScopeReload = nextScope;
        // Tell the renderer to re-hydrate the active conversation since the
        // scope (and thus the displayed mod context) changed underneath it.
        this.sendToRenderer('modmixer:agent:scope-upgraded', {
          conversationId,
          scope: nextScope,
        });
      }
    }
  }

  /**
   * Open a conversation as a live session — one mod tab. Get-or-create: if a
   * session for this conversation is already open it's returned untouched,
   * and every other open session keeps running. Background bridge monitoring
   * is NOT disturbed: a test armed in one tab survives the user opening or
   * focusing another.
   */
  async openSession(conversationId: string): Promise<Conversation> {
    const convo = getConversation(conversationId);
    if (!convo) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    if (this.sessions.has(conversationId)) return convo;
    let pending = this.constructing.get(conversationId);
    if (!pending) {
      pending = this.constructSession(convo);
      this.constructing.set(conversationId, pending);
      try {
        this.sessions.set(conversationId, await pending);
      } finally {
        this.constructing.delete(conversationId);
      }
    } else {
      // Another caller is already constructing this session — wait for it.
      await pending;
    }
    return convo;
  }

  /** Tear down a session — used when the user closes a mod tab. */
  async closeSession(conversationId: string): Promise<void> {
    if (this.monitoringConversationId === conversationId) {
      this.stopMonitoring();
    }
    if (this.liveConversationId === conversationId) {
      this.stopLiveSession();
    }
    await this.disposeSession(conversationId);
  }

  /**
   * Free a session the multi-chat UI has switched away from. Unlike
   * closeSession this is conservative: it skips a chat with a turn in flight
   * (disposing would abort live work) and skips the chat currently driving
   * in-game monitoring. The session reconstructs lazily on the next
   * openSession, so switching back is seamless. This is what keeps memory
   * bounded when a mod accumulates many chats.
   */
  async releaseIdleSession(conversationId: string): Promise<void> {
    if (!this.sessions.has(conversationId)) return;
    if (this.busyConversations.has(conversationId)) return;
    if (this.monitoringConversationId === conversationId) return;
    // A live-bound chat must stay constructed — in-game prompts can arrive
    // at any moment (handleLivePrompt would reconstruct, but releasing an
    // armed session just to rebuild it on the next keystroke is churn).
    if (this.liveConversationId === conversationId) return;
    await this.disposeSession(conversationId);
  }

  /** Live messages for one open conversation; empty when it isn't open. */
  getMessages(conversationId: string): AgentMessage[] {
    return (
      this.sessions.get(conversationId)?.session.agent.state.messages ?? []
    );
  }

  /**
   * Create a new conversation entry and pre-write its session header to
   * disk. pi defers flushing until the first assistant message lands, but we
   * want a stable id ↔ session-file mapping in our index even before the
   * first message — otherwise SessionManager.open on a later openSession
   * would mint a fresh id internally and our index id would diverge from the
   * eventual JSONL header.
   */
  async createConversation(
    scope: ConversationScope,
    title?: string,
    opts?: { live?: boolean },
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
    // conversation's lifetime — see Conversation.systemPrompt. Stamp the
    // current settings defaults as this chat's starting model + thinking
    // level; from here they're the chat's own and the settings default only
    // affects subsequently-created chats.
    const settings = loadSettings();
    // Resolve the conversation's game once, here: a mod chat inherits the mod's
    // game; a new-scope chat uses the active game. Frozen onto the record so
    // the prompt + tools stay game-stable for the chat's life.
    const game: GameId =
      scope.type === 'mod'
        ? (await readModPrefs(scope.modFolder)).game
        : settings.selectedGameId;
    return addConversation({
      id,
      sessionFile,
      scope,
      title,
      systemPrompt: buildSystemPrompt(scope, { live: opts?.live, game }),
      model: settings.model ?? undefined,
      thinkingLevel: settings.thinkingLevel,
      live: opts?.live,
      game,
    });
  }

  async deleteConversation(id: string): Promise<void> {
    await this.disposeSession(id);
    const sessionFile = removeConversation(id);
    if (sessionFile && fs.existsSync(sessionFile)) {
      try {
        fs.unlinkSync(sessionFile);
      } catch (err) {
        console.error('Failed to delete session file:', sessionFile, err);
      }
    }
  }

  async send(
    conversationId: string,
    text: string,
    attachments?: PreparedAttachment[],
  ): Promise<void> {
    let entry = this.sessions.get(conversationId);
    if (!entry) {
      throw new Error(`No open session for conversation: ${conversationId}`);
    }
    if (entry.pendingScopeReload) {
      const convo = getConversation(conversationId);
      if (convo) {
        await this.disposeSession(conversationId);
        entry = await this.constructSession(convo);
        this.sessions.set(conversationId, entry);
      }
    }
    // Re-warm on every user message, not just session open: the OS evicts the
    // source corpus within minutes under memory pressure, so a chat that sat
    // idle would otherwise hit a cold search_source. The 5-min cooldown inside
    // warmSearchCache keeps this to at most one background sweep per window.
    void warmSearchCache('prompt');
    const { promptText, images } = await buildAttachedPrompt(
      entry,
      text,
      attachments,
    );
    await entry.session.prompt(promptText, {
      streamingBehavior: 'steer',
      expandPromptTemplates: false,
      images,
    });
  }

  /**
   * Cancel the in-flight turn. Pi settles the run with `stopReason: "aborted"`
   * and emits `agent_end`, so the renderer's existing `busy` reset still fires.
   * No-op when there's no active session or no run in flight.
   */
  async interrupt(conversationId: string): Promise<void> {
    const entry = this.sessions.get(conversationId);
    if (!entry) return;
    await entry.session.abort();
  }

  // =========================================================================
  // Saves (snapshots)
  // =========================================================================

  /**
   * User-pressed "Save". Snapshots the full state of the mod (folder +
   * chats + active chat) for the given workspace folder.
   */
  async commitManualSave(
    folder: string,
    label: string | null,
  ): Promise<SaveRecord | null> {
    return commitTurn(folder, {
      kind: 'manual',
      label: label ?? undefined,
    });
  }

  /**
   * Wind a mod back to a saved state. The snapshot replays the mod folder
   * AND the chat slice (conversations + which one was active), so chats
   * that didn't exist at save time disappear and the active chat reverts
   * to whatever was active then.
   *
   * Returns the hydrated active conversation after restore (or null if the
   * snapshot had nothing active). The renderer applies this to its state
   * so the UI re-renders against the restored world without a manual
   * reload step.
   */
  async restoreSave(args: { folder: string; sha: string }): Promise<{
    conversation: Conversation;
    messages: AgentMessage[];
  } | null> {
    // Pi may be holding session files open for any chat scoped to this mod.
    // Drop every such session before snapshots.ts rewrites the underlying
    // JSONLs. (Collect ids first — disposeSession mutates the map.)
    const folderSessions = [...this.sessions.values()].filter(
      (e) => e.scope.type === 'mod' && e.scope.modFolder === args.folder,
    );
    for (const entry of folderSessions) {
      await this.disposeSession(entry.conversationId);
    }

    const { activeConversation } = await restoreSnapshot(
      args.folder,
      args.sha,
    );

    if (!activeConversation) return null;
    const convo = await this.openSession(activeConversation.id);
    return {
      conversation: convo,
      messages: this.getMessages(convo.id),
    };
  }

  /**
   * Switch one chat's model — persists the per-conversation selection and
   * applies it to the live session if that chat is open. Other chats are
   * untouched; the model is per-conversation, not global.
   */
  async setConversationModel(
    conversationId: string,
    selection: ModelSelection,
  ): Promise<void> {
    const model = this.modelRegistry.find(selection.provider, selection.modelId);
    if (!model) {
      throw new Error(
        `Unknown model: ${selection.provider}/${selection.modelId}`,
      );
    }
    setConvModel(conversationId, selection);
    const entry = this.sessions.get(conversationId);
    if (entry) await entry.session.setModel(model);
  }

  /**
   * Switch one chat's reasoning effort. Pi clamps internally against the
   * model's available levels, so passing "xhigh" to Kimi quietly becomes
   * "high" inside the session — the persisted value is the user's intent,
   * not necessarily what the next turn runs at.
   */
  setConversationThinkingLevel(
    conversationId: string,
    level: ThinkingLevel,
  ): void {
    setConvThinkingLevel(conversationId, level);
    const entry = this.sessions.get(conversationId);
    if (entry) entry.session.setThinkingLevel(level);
  }

  /**
   * Re-bind every open session's model after credentials change (login /
   * logout / key edit). Each session re-resolves from its own conversation's
   * pick, falling back through resolveModel's chain if that pick's provider
   * is the one that just lost auth.
   */
  private async refreshActiveModel(): Promise<void> {
    for (const entry of this.sessions.values()) {
      const convo = getConversation(entry.conversationId);
      const model = this.resolveModel(convo?.model);
      if (!model) continue;
      try {
        await entry.session.setModel(model);
      } catch (err) {
        console.error('Failed to swap session model after auth change:', err);
      }
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
          vision: m.input.includes('image'),
        });
      }
    }
    // OpenRouter: surface every slug the user has explicitly saved, plus
    // the pinned recommended slugs. We deliberately don't gate on whether an
    // API key is present — adding a slug is the explicit "I want this"
    // signal, and if the key is missing OpenRouter will return a clear error
    // at first prompt.
    for (const slug of this.getEffectiveOpenRouterModels()) {
      const orModel = all.find(
        (x) => x.provider === OPENROUTER_PROVIDER && x.id === slug,
      );
      out.push({
        key: `${OPENROUTER_PROVIDER}/${slug}`,
        provider: OPENROUTER_PROVIDER,
        providerLabel: providerLabel(OPENROUTER_PROVIDER),
        modelId: slug,
        label: slug,
        recommended: isPinnedOpenRouterSlug(slug),
        vision: orModel ? orModel.input.includes('image') : undefined,
      });
    }
    // Local OpenAI-compatible servers: one row per user-added model. Provider
    // label comes straight from the user's settings entry, so multiple local
    // servers stay distinguishable in the picker (e.g. "LM Studio" vs
    // "Ollama").
    for (const local of loadSettings().localProviders) {
      const name = localProviderName(local.id);
      for (const modelId of local.models) {
        const lm = all.find(
          (x) => x.provider === name && x.id === modelId,
        );
        out.push({
          key: `${name}/${modelId}`,
          provider: name,
          providerLabel: local.label,
          modelId,
          label: modelId,
          vision: lm ? lm.input.includes('image') : undefined,
        });
      }
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
      models: this.getEffectiveOpenRouterModels(),
      pinnedModels: [...PINNED_OR_MODELS],
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
    // Pinned slugs are already in the effective list — no need to persist.
    if (isPinnedOpenRouterSlug(cleaned)) return this.getOpenRouterConfig();
    const current = loadSettings().openrouterModels;
    if (current.includes(cleaned)) return this.getOpenRouterConfig();
    saveSettings({ openrouterModels: [...current, cleaned] });
    this.applyOpenRouterRegistration();
    this.emitOAuth({ type: 'links-changed' });
    return this.getOpenRouterConfig();
  }

  /**
   * Live context-window usage for one open conversation. Returns null when
   * that conversation has no open session, or pi can't compute usage (no
   * model bound yet, fresh-after-compaction, etc.). Pi's value comes from
   * the most recent assistant `usage` plus an estimate of any newer
   * messages, so it updates per-turn without us having to count tokens.
   */
  getContextUsage(conversationId: string): ContextUsage | null {
    return (
      this.sessions.get(conversationId)?.session.getContextUsage() ?? null
    );
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
    // Pinned slugs are locked — the UI hides Remove for them, but guard the
    // IPC entry point too in case it's called directly.
    if (isPinnedOpenRouterSlug(slug)) return this.getOpenRouterConfig();
    const current = loadSettings().openrouterModels;
    const next = current.filter((s) => s !== slug);
    if (next.length === current.length) return this.getOpenRouterConfig();
    saveSettings({ openrouterModels: next });
    this.applyOpenRouterRegistration();
    this.emitOAuth({ type: 'links-changed' });
    await this.refreshActiveModel();
    return this.getOpenRouterConfig();
  }

  // ---------------------------------------------------------------------------
  // Local OpenAI-compatible providers (LM Studio, Ollama, vLLM, llama.cpp, …)
  // ---------------------------------------------------------------------------

  /**
   * Register every saved local provider with pi-ai. Called on startup and
   * after any add/edit/remove. Skips entries with no models — pi rejects a
   * model-less provider config anyway, and a "configured but empty" entry
   * surfaces no picker rows.
   */
  private applyLocalProvidersRegistration(): void {
    const { localProviders } = loadSettings();
    for (const provider of localProviders) {
      this.registerOneLocalProvider(provider);
    }
  }

  private registerOneLocalProvider(provider: LocalProvider): void {
    const name = localProviderName(provider.id);
    if (provider.models.length === 0) {
      // Nothing to register; ensure any previous registration is dropped so a
      // stale provider doesn't linger after the user removes its last model.
      this.modelRegistry.unregisterProvider(name);
      return;
    }
    const cred = this.authStorage.get(name);
    const apiKey =
      cred?.type === 'api_key' && cred.key ? cred.key : LOCAL_PROVIDER_PLACEHOLDER_KEY;
    const zero: OpenRouterCost = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
    this.modelRegistry.registerProvider(name, {
      baseUrl: provider.baseUrl,
      api: 'openai-completions',
      apiKey,
      models: provider.models.map((id) => ({
        id,
        name: id,
        // Local servers vary wildly in reasoning support — leave the dropdown
        // gated to "off" by default. Power users can flip thinking via prompt.
        reasoning: false,
        input: ['text'],
        cost: zero,
        contextWindow: 128_000,
        maxTokens: 16_384,
      })),
    });
  }

  getLocalProviders(): LocalProvider[] {
    return loadSettings().localProviders.map((p) => ({ ...p, models: [...p.models] }));
  }

  /**
   * Create a new local provider entry. `apiKey` is optional — pass `null`
   * for servers that don't authenticate (the common case).
   */
  async addLocalProvider(input: {
    label: string;
    baseUrl: string;
    apiKey?: string | null;
  }): Promise<LocalProvider[]> {
    const label = input.label.trim();
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
    if (!label || !baseUrl) return this.getLocalProviders();
    const provider: LocalProvider = {
      id: randomUUID(),
      label,
      baseUrl,
      models: [],
    };
    const current = loadSettings().localProviders;
    saveSettings({ localProviders: [...current, provider] });
    if (input.apiKey && input.apiKey.trim().length > 0) {
      this.authStorage.set(localProviderName(provider.id), {
        type: 'api_key',
        key: input.apiKey.trim(),
      });
    }
    this.registerOneLocalProvider(provider);
    this.emitOAuth({ type: 'links-changed' });
    return this.getLocalProviders();
  }

  async updateLocalProvider(
    id: string,
    patch: { label?: string; baseUrl?: string; apiKey?: string | null },
  ): Promise<LocalProvider[]> {
    const current = loadSettings().localProviders;
    const idx = current.findIndex((p) => p.id === id);
    if (idx < 0) return this.getLocalProviders();
    const next = [...current];
    const merged: LocalProvider = { ...next[idx] };
    if (patch.label !== undefined) {
      const v = patch.label.trim();
      if (v) merged.label = v;
    }
    if (patch.baseUrl !== undefined) {
      const v = patch.baseUrl.trim().replace(/\/+$/, '');
      if (v) merged.baseUrl = v;
    }
    next[idx] = merged;
    saveSettings({ localProviders: next });
    if (patch.apiKey !== undefined) {
      const name = localProviderName(id);
      if (patch.apiKey && patch.apiKey.trim().length > 0) {
        this.authStorage.set(name, { type: 'api_key', key: patch.apiKey.trim() });
      } else {
        this.authStorage.remove(name);
      }
    }
    this.registerOneLocalProvider(merged);
    this.emitOAuth({ type: 'links-changed' });
    await this.refreshActiveModel();
    return this.getLocalProviders();
  }

  async removeLocalProvider(id: string): Promise<LocalProvider[]> {
    const current = loadSettings().localProviders;
    const next = current.filter((p) => p.id !== id);
    if (next.length === current.length) return this.getLocalProviders();
    saveSettings({ localProviders: next });
    const name = localProviderName(id);
    this.authStorage.remove(name);
    this.modelRegistry.unregisterProvider(name);
    this.emitOAuth({ type: 'links-changed' });
    await this.refreshActiveModel();
    return this.getLocalProviders();
  }

  async addLocalModel(id: string, modelId: string): Promise<LocalProvider[]> {
    const cleaned = modelId.trim();
    if (!cleaned) return this.getLocalProviders();
    const current = loadSettings().localProviders;
    const idx = current.findIndex((p) => p.id === id);
    if (idx < 0) return this.getLocalProviders();
    if (current[idx].models.includes(cleaned)) return this.getLocalProviders();
    const next = [...current];
    next[idx] = { ...next[idx], models: [...next[idx].models, cleaned] };
    saveSettings({ localProviders: next });
    this.registerOneLocalProvider(next[idx]);
    this.emitOAuth({ type: 'links-changed' });
    return this.getLocalProviders();
  }

  async removeLocalModel(id: string, modelId: string): Promise<LocalProvider[]> {
    const current = loadSettings().localProviders;
    const idx = current.findIndex((p) => p.id === id);
    if (idx < 0) return this.getLocalProviders();
    const filtered = current[idx].models.filter((m) => m !== modelId);
    if (filtered.length === current[idx].models.length) return this.getLocalProviders();
    const next = [...current];
    next[idx] = { ...next[idx], models: filtered };
    saveSettings({ localProviders: next });
    this.registerOneLocalProvider(next[idx]);
    this.emitOAuth({ type: 'links-changed' });
    await this.refreshActiveModel();
    return this.getLocalProviders();
  }

  /**
   * Hit the local server's `/models` endpoint and return the advertised
   * model ids. Powers the "Discover" button in settings so users can see
   * what their LM Studio / Ollama / vLLM instance is serving without
   * typing ids by hand. Trailing `/v1` is preserved; we just append `/models`.
   */
  async discoverLocalModels(baseUrl: string): Promise<string[]> {
    const trimmed = baseUrl.trim().replace(/\/+$/, '');
    if (!trimmed) return [];
    const url = `${trimmed}/models`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText} from ${url}`);
    }
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    if (!body || !Array.isArray(body.data)) return [];
    return body.data
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
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
        onPrompt: (prompt: OAuthPrompt) => {
          // Modmixer targets individual users, not orgs. pi's GitHub Copilot
          // flow opens with a "GitHub Enterprise URL/domain" prompt; auto-answer
          // it with "" (→ github.com) so it never reaches the UI. It's also the
          // only prompt that flow issues before opening the browser, so
          // suppressing it is what lets the device-code box render at all.
          if (providerId === 'github-copilot' && /enterprise/i.test(prompt.message)) {
            return Promise.resolve('');
          }
          return this.awaitPrompt(providerId, prompt);
        },
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
  // Background bridge monitoring (drives the test-in-game flow)
  // =========================================================================

  /**
   * Arm the bridge monitor for the test session. Resolves the mod-under-test
   * context (display name + packageId) so warning-attribution filtering can
   * give the agent's mod a free pass and the user's mod isn't lumped in
   * with vanilla-attributed warnings via the count-only threshold.
   *
   * `isolated` is stashed only to drive teardown: in non-isolated mode we
   * also strip modmixer.bridge from the user's real <activeMods> after the
   * session ends, so RimWorld doesn't warn about a missing mod next launch.
   */
  async startMonitoring(opts: {
    conversationId: string;
    modFolder: string;
    isolated: boolean;
  }): Promise<void> {
    // One game, one bridge socket, one ModsConfig.xml — in-game testing is a
    // genuine singleton. If another conversation is already monitoring a
    // test, refuse rather than silently stealing the bridge; the second
    // mod's run_test_cycle surfaces this as an error tool result.
    if (
      this.monitoringConversationId &&
      this.monitoringConversationId !== opts.conversationId
    ) {
      throw new Error(
        'Another mod is already being tested in RimWorld. Only one in-game ' +
          'test can run at a time — finish that test (or close RimWorld) ' +
          'before testing this mod.',
      );
    }
    this.stopMonitoring();
    this.monitoringConversationId = opts.conversationId;
    this.monitoringIsolated = opts.isolated;
    this.bridgeSeenConnected = false;
    this.bridgeErrorsSeen = false;

    let modUnderTest: { name: string; packageId: string } | undefined;
    try {
      const mod = await getWorkspaceMod(opts.modFolder);
      if (mod) {
        modUnderTest = {
          name: mod.about.name,
          packageId: mod.about.packageId,
        };
      }
    } catch (err) {
      console.error('startMonitoring: failed to resolve mod context:', err);
    }

    const monitor = getMonitorServer();
    this.errorBuffer = new ErrorBuffer();
    this.errorBufferDetach = this.errorBuffer.attach(monitor, { modUnderTest });
    const conversationId = opts.conversationId;
    this.errorBuffer.subscribe((groups, runId) =>
      void this.handleBridgeErrors(groups, runId, conversationId),
    );

    this.monitorStateHandler = (state) => this.onMonitorState(state);
    monitor.on('state', this.monitorStateHandler);

    // The bridge may already be connected (rare race: a previous test
    // session's RimWorld is still up). If so, treat that as "seen" too,
    // so disconnect fires the session-ended toast.
    if (monitor.getState().kind === 'connected') {
      this.bridgeSeenConnected = true;
    }

    sendToast('Modmixer', 'Watching for diagnostics — go test the mod.');
    this.heartbeatTimer = setInterval(() => {
      // Skip the reassurance once errors have actually landed — saying
      // "no errors yet" 60s after the user got an error toast is jarring
      // and undermines the previous toast. The chat already shows what was
      // caught, and the next batch (if any) lands as a fresh toast.
      if (this.bridgeErrorsSeen) return;
      sendToast('Modmixer', 'So far so good — no errors yet.', {
        silent: true,
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopMonitoring(): void {
    this.errorBufferDetach?.();
    this.errorBufferDetach = null;
    this.errorBuffer = null;
    if (this.monitorStateHandler) {
      getMonitorServer().off('state', this.monitorStateHandler);
      this.monitorStateHandler = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.monitoringConversationId = null;
    this.monitoringIsolated = false;
    this.bridgeSeenConnected = false;
    this.bridgeErrorsSeen = false;
  }

  private onMonitorState(state: MonitorConnectionState): void {
    if (state.kind === 'connected') {
      this.bridgeSeenConnected = true;
      return;
    }
    // Disconnected (or back to listening). If we never saw the bridge come
    // up, this is just the initial state — don't fire teardown. Otherwise
    // the in-game side dropped us, which means the game is quitting (or
    // crashed). Tear down + clean up the bridge install.
    if (!this.bridgeSeenConnected) return;
    sendToast('Modmixer', 'RimWorld closed — test session ended.');
    const wasNonIsolated = !this.monitoringIsolated;
    this.stopMonitoring();
    void this.teardownBridgeInstall(wasNonIsolated);
  }

  /**
   * Remove the bridge junction (always) and, when the test session ran
   * against the user's real ModsConfig, strip `modmixer.bridge` from
   * <activeMods> so a subsequent manual Steam launch doesn't trip RimWorld's
   * "missing mod" warning. Failures are logged; we don't surface them to
   * the user because there's nothing actionable on this side of the flow.
   */
  private async teardownBridgeInstall(stripFromActiveMods: boolean): Promise<void> {
    try {
      await removeBridgeInstall();
    } catch (err) {
      console.error('Failed to remove bridge install:', err);
    }
    if (!stripFromActiveMods) return;
    try {
      const registry = getRegistry();
      const snap = registry.getSnapshot();
      if (!snap.activeOrder.includes(BRIDGE_PACKAGE_ID)) return;
      const next = snap.activeOrder.filter((p) => p !== BRIDGE_PACKAGE_ID);
      await registry.setActiveMods(next);
    } catch (err) {
      console.error('Failed to strip bridge from active mods:', err);
    }
  }

  // =========================================================================
  // Live sessions (in-game prompting)
  // =========================================================================

  /**
   * Bind the Live channel to a conversation. Called by launchLiveSession
   * right after the game is spawned. Prompts from the in-game window are
   * steered into this conversation's session; its events flow back via
   * relayLiveEvent. Refuses to steal an existing binding for the same
   * reason startMonitoring does.
   */
  startLiveSession(conversationId: string): void {
    if (this.liveConversationId && this.liveConversationId !== conversationId) {
      throw new Error(
        'Another live session is already active. Close its RimWorld instance first.',
      );
    }
    this.stopLiveSession();
    this.liveConversationId = conversationId;
    this.liveSeenConnected = false;
    // Snapshot which junction install this session owns — its teardown may
    // race a newer session's launch and must not delete that one's junction.
    this.liveInstallEpoch = currentLiveInstallEpoch();

    const live = getLiveServer();
    this.livePromptHandler = (p) => void this.handleLivePrompt(p, conversationId);
    live.on('prompt', this.livePromptHandler);
    this.liveStateHandler = (s) => this.onLiveState(s);
    live.on('state', this.liveStateHandler);
    if (live.getState().kind === 'connected') {
      this.liveSeenConnected = true;
    }
  }

  stopLiveSession(): void {
    const live = getLiveServer();
    if (this.livePromptHandler) {
      live.off('prompt', this.livePromptHandler);
      this.livePromptHandler = null;
    }
    if (this.liveStateHandler) {
      live.off('state', this.liveStateHandler);
      this.liveStateHandler = null;
    }
    this.liveConversationId = null;
    this.liveSeenConnected = false;
  }

  private onLiveState(state: LiveConnectionState): void {
    if (state.kind === 'connected') {
      this.liveSeenConnected = true;
      return;
    }
    if (!this.liveSeenConnected) return;
    // The in-game side dropped us — the game is quitting (or crashed).
    // Unlike the bridge (which rides along with every test cycle), Live
    // must never linger into ordinary sessions, so the junction goes now.
    sendToast('Modmixer', 'RimWorld closed — live session ended.');
    const epoch = this.liveInstallEpoch;
    this.stopLiveSession();
    void removeLiveInstall(epoch).catch((err) => {
      console.error('Failed to remove live install:', err);
    });
  }

  private async handleLivePrompt(
    prompt: LiveUserPrompt,
    conversationId: string,
  ): Promise<void> {
    if (this.liveConversationId !== conversationId) return;
    const text = prompt.text.trim();
    if (!text) return;
    try {
      // The session may have been released (memory pressure, app restart
      // mid-game) — reconstruct it rather than dropping the prompt.
      if (!this.sessions.has(conversationId)) {
        await this.openSession(conversationId);
      }
      const entry = this.sessions.get(conversationId);
      if (!entry) return;
      // Same steer semantics as bridge error auto-prompts: queues if a
      // turn is in flight, starts one otherwise. The [in-game] tag tells
      // the agent (and the transcript) where this came from.
      await entry.session.prompt(`[in-game] ${text}`, {
        streamingBehavior: 'steer',
      });
    } catch (err) {
      console.error('Failed to prompt session with in-game message:', err);
      getLiveServer().push({
        type: 'agent_say',
        text: 'Something went wrong handling that — check the Modmixer app.',
      });
    }
  }

  /**
   * Project this conversation's agent events down to the in-game window's
   * tiny vocabulary. Deliberately lossy: tool calls become one of a few
   * friendly ticker strings, and only a turn's final assistant message
   * becomes a chat bubble — the in-game UI is a toy, not a transcript.
   */
  private relayLiveEvent(
    conversationId: string,
    event: AgentSessionEvent,
  ): void {
    if (this.liveConversationId !== conversationId) return;
    const live = getLiveServer();
    if (!live.isConnected()) return;

    if (event.type === 'agent_start') {
      live.push({ type: 'agent_busy', busy: true });
      live.push({ type: 'agent_status', text: 'thinking' });
    } else if (event.type === 'agent_end') {
      live.push({ type: 'agent_busy', busy: false });
    } else if (event.type === 'tool_execution_start') {
      live.push({
        type: 'agent_status',
        text: liveStatusForTool(event.toolName),
      });
    } else if (event.type === 'turn_end') {
      const text = messageText(event.message).trim();
      if (text) {
        // The window renders plain wrapped labels; clamp pathological
        // lengths rather than letting one verbose turn flood the UI.
        live.push({
          type: 'agent_say',
          text: text.length > 2000 ? text.slice(0, 1999) + '…' : text,
        });
      }
    }
  }

  private async handleBridgeErrors(
    groups: ErrorBufferGroup[],
    runId: number,
    conversationId: string,
  ): Promise<void> {
    if (groups.length === 0) return;
    if (this.monitoringConversationId !== conversationId) return;
    // Don't stop monitoring — the buffer stays attached. It's edge-triggered:
    // a class already reported in this run won't prompt again, but a class
    // first seen later in the run lands as its own fresh auto-prompt.
    const entry = this.sessions.get(conversationId);
    if (!entry) return;

    // Suppress the "so far so good" heartbeat now that we've actually seen
    // diagnostics. Set this BEFORE the toast/prompt so a 60s timer firing
    // mid-await doesn't beat us to it.
    this.bridgeErrorsSeen = true;

    const classWord = groups.length === 1 ? 'error' : 'errors';
    sendToast(
      'Modmixer',
      `Run #${runId}: ${groups.length} new ${classWord} — investigating…`,
    );

    try {
      // session.prompt() picks the right path automatically (queues via steer
      // if a turn is already in flight, otherwise starts a new turn). The
      // triage rubric for interpreting this summary lives in the system
      // prompt — only the dynamic summary lands in the chat.
      await entry.session.prompt(formatErrorSummary(groups, runId), {
        streamingBehavior: 'steer',
      });
    } catch (err) {
      console.error('Failed to prompt session with bridge errors:', err);
    }
  }

  /**
   * Backstop for the Minecraft test loop: surface a launch/load diagnostic
   * detected from the `gradlew runClient` output (e.g. a NeoForge mod-loading
   * failure that shows the in-game error screen) into the conversation. This
   * covers the gap where the in-game bridge can't report — load-time failures
   * abort the mod event bus before the bridge's hooks run, so without this the
   * agent would see a green build + no bridge errors and wrongly conclude all
   * is well. Same steer semantics as bridge error auto-prompts; reported once
   * per test run by the caller.
   */
  async reportTestDiagnostic(conversationId: string, text: string): Promise<void> {
    if (this.monitoringConversationId !== conversationId) return;
    const entry = this.sessions.get(conversationId);
    if (!entry) return;
    this.bridgeErrorsSeen = true;
    sendToast('Modmixer', 'Mod failed to load — investigating…');
    try {
      await entry.session.prompt(text, { streamingBehavior: 'steer' });
    } catch (err) {
      console.error('Failed to prompt session with launch diagnostic:', err);
    }
  }

  /**
   * Demo-video harness only — the IPC handler is registered behind
   * MODMIXER_DEMO=1 in main.ts. One-shot completion against the user's
   * configured Anthropic credentials (OAuth subscription or API key), so the
   * harness's "user-actor" bills like the app itself instead of needing a
   * separate ANTHROPIC_API_KEY.
   */
  async demoComplete(args: {
    modelId: string;
    system: string;
    user: string;
  }): Promise<string> {
    const model = this.modelRegistry.find('anthropic', args.modelId);
    if (!model) throw new Error(`unknown anthropic model: ${args.modelId}`);
    const auth = await this.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);
    const result = await complete(
      model,
      {
        systemPrompt: args.system,
        messages: [{ role: 'user', content: args.user, timestamp: Date.now() }],
      },
      {
        apiKey: auth.apiKey,
        maxTokens: 400,
        ...(auth.headers ? { headers: auth.headers } : {}),
      },
    );
    return result.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }

  async shutdown(): Promise<void> {
    this.stopMonitoring();
    this.stopLiveSession();
    for (const id of [...this.sessions.keys()]) {
      await this.disposeSession(id);
    }
  }
}

/**
 * Friendly ticker strings for the in-game window. Coarse on purpose — the
 * player should see "building…" not tool names and arguments.
 */
function liveStatusForTool(toolName: string): string {
  switch (toolName) {
    case 'write':
    case 'edit':
      return 'writing code';
    case 'build_mod':
      return 'building';
    case 'apply_live':
      return 'applying to your game';
    case 'game_action':
      return 'running it in your game';
    case 'monitor_get_error':
    case 'monitor_poll':
      return 'checking for errors';
    case 'read':
    case 'grep':
    case 'find':
    case 'ls':
    case 'search_defs':
    case 'search_source':
    case 'read_csharp_symbol':
    case 'read_lore':
    case 'decompile_dll':
    case 'list_installed_mods':
      return 'reading up';
    default:
      return 'working';
  }
}
