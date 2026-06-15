import { ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AgentMessage, ThinkingLevel } from '@mariozechner/pi-agent-core';
import type {
  Consent,
  LocalProvider,
  ModelSelection,
  OnboardingState,
  Settings,
  ThemePreference,
} from '../agent/settings';
import type { EnvSnapshot } from '../agent/env-detect';
import type { ModelOption } from '../agent/models';
import type {
  OAuthEvent,
  OAuthLink,
  OpenRouterConfig,
} from '../agent/agent-host';
import type { OpenRouterCredits } from '../agent/openrouter-credits';
import type { Conversation, ConversationScope } from '../agent/conversations';
import type {
  AboutMetadata,
  ImportModResult,
  WorkspaceMod,
  WorkspacePaths,
} from '../agent/workspace';
import type { SchematicData } from '../agent/schematic';
import type { DefEntry } from '../agent/defs-scan';
import type { EnableResult, DisableResult } from '../agent/game';
import type { AssetKind, AssetScan, AssetSlotRef } from '../agent/assets/types';
import type {
  AttachmentInput,
  PreparedAttachment,
} from '../agent/attachments/types';
import type {
  BridgeMessage,
  ModsSnapshot,
  MonitorConnectionState,
} from '../agent/monitor/protocol';
import type { LiveConnectionState } from '../agent/live/protocol';
import type { LiveLaunchResult } from '../agent/live/session';
import type {
  PublishProgressEvent,
  PublishResult,
} from '../agent/workshop';
import type { SaveRecord, SnapshotsChangedEvent } from '../agent/snapshots';
import type { ConfirmationRequest } from '../agent/security/confirmation-gate';
import type { IndexSnapshot } from '../agent/index/main-bridge';
import type { UpdaterState } from '../agent/updater';
import type { IndexProgressEvent } from '../agent/index/progress';
import type {
  ActiveDiff,
  ActiveSession,
  AutosortResult,
  ModDependency,
} from '../agent/registry';

export interface AgentEventEnvelope {
  conversationId: string | null;
  event: import('@mariozechner/pi-coding-agent').AgentSessionEvent;
}

export interface RegistryEnvelope {
  snapshot: import('../agent/registry').RegistrySnapshot;
  analysis: import('../agent/registry').AnalysisResult;
}

export interface AssetsChangedEnvelope {
  folder: string;
}

export interface ModChangedEnvelope {
  folder: string;
}

export interface ScopeUpgradedEnvelope {
  conversationId: string;
  scope: ConversationScope;
}

export interface HydratedConversation {
  conversation: Conversation;
  messages: AgentMessage[];
}

export interface EnableWithDepsResult {
  envelope: RegistryEnvelope;
  added: string[];
  missing: string[];
  alreadyActive: boolean;
  conflicts: import('../agent/registry').AutosortConflict[];
}

export interface CommunityRulesInfo {
  fetchedAt: string | null;
  source: 'cache' | 'fetched' | 'bundled' | 'empty';
  count: number;
  rules?: Record<string, unknown>;
}

/**
 * Single source of truth for every request/response IPC channel — channel
 * name to function shape. Helpers below derive args/return from this map,
 * so preload methods can't accidentally call a renamed channel and main
 * handlers can't drift from what the renderer expects (each entry is
 * shared by both ends through this file's type imports).
 *
 * Use a function shape (e.g. `(text: string) => void`) rather than a
 * tuple — easier to read, and `Parameters<T>` / `ReturnType<T>` recover
 * everything we need.
 */
export interface Channels {
  // App
  'modmixer:app:version': () => string;

  // Updater
  'modmixer:updater:get-state': () => UpdaterState;
  'modmixer:updater:check': () => UpdaterState;
  'modmixer:updater:quit-and-install': () => void;

  // Consent
  'modmixer:consent:get': () => { required: string; accepted: Consent | null };
  'modmixer:consent:accept': (options?: { analyticsOptIn?: boolean }) => Settings;

  // Onboarding
  'modmixer:onboarding:get-status': () => {
    required: string;
    completed: OnboardingState | null;
    shouldShow: boolean;
  };
  'modmixer:onboarding:complete': () => Settings;
  'modmixer:onboarding:reset': () => Settings;

  // Env
  'modmixer:env:detect': () => EnvSnapshot;
  'modmixer:env:browse-rimworld-install': () => string | null;
  'modmixer:env:clear-rimworld-install-override': () => null;

  // Agent
  'modmixer:agent:send': (
    conversationId: string,
    text: string,
    attachments?: PreparedAttachment[],
  ) => void;
  'modmixer:agent:interrupt': (conversationId: string) => void;
  'modmixer:agent:close': (conversationId: string) => void;
  'modmixer:agent:release-idle': (conversationId: string) => void;
  'modmixer:agent:get-context-usage': (
    conversationId: string,
  ) => import('@mariozechner/pi-coding-agent').ContextUsage | null;
  // Demo-video harness only — handler registered behind MODMIXER_DEMO=1.
  'modmixer:demo:complete': (args: {
    modelId: string;
    system: string;
    user: string;
  }) => string;

  // Settings
  'modmixer:settings:get': () => Settings;
  'modmixer:settings:set-model': (selection: ModelSelection) => Settings;
  'modmixer:settings:set-default-author': (author: string) => Settings;
  'modmixer:settings:set-analytics-opt-in': (optIn: boolean) => Settings;
  'modmixer:settings:set-theme': (theme: ThemePreference) => Settings;
  'modmixer:settings:set-thinking-level': (level: ThinkingLevel) => Settings;
  'modmixer:settings:set-multi-chat': (enabled: boolean) => Settings;
  'modmixer:settings:set-community-lore': (enabled: boolean) => Settings;
  'modmixer:settings:set-auto-launch': (enabled: boolean) => Settings;
  'modmixer:settings:set-dangerously-skip-permissions': (
    enabled: boolean,
  ) => Settings;
  'modmixer:models:list': () => ModelOption[];

  // Conversations
  'modmixer:conversations:list': () => Conversation[];
  'modmixer:conversations:list-for-mod': (folder: string) => Conversation[];
  'modmixer:conversations:archive': (id: string) => void;
  'modmixer:conversations:unarchive': (id: string) => void;
  'modmixer:conversations:set-active-for-mod': (
    folder: string,
    id: string,
  ) => void;
  'modmixer:conversations:create': (
    scope: ConversationScope,
    title?: string,
  ) => Conversation;
  'modmixer:conversations:delete': (id: string) => void;
  'modmixer:conversations:set-model': (
    conversationId: string,
    selection: ModelSelection,
  ) => void;
  'modmixer:conversations:set-thinking-level': (
    conversationId: string,
    level: ThinkingLevel,
  ) => void;
  'modmixer:conversations:resolve-for-mod': (folder: string) => Conversation;
  'modmixer:conversations:open-session': (
    conversationId: string,
  ) => { messages: AgentMessage[] };
  'modmixer:conversations:start-fresh-for-mod': (folder: string) => Conversation;
  'modmixer:conversations:copy-session-log': (
    conversationId: string,
  ) =>
    | { ok: true; bytes: number }
    | { ok: false; reason: 'not-found' | 'unreadable' };

  // Mods (workspace)
  'modmixer:mods:list-workspace': () => WorkspaceMod[];
  'modmixer:mods:sync-to-game': (folder: string) => WorkspaceMod[];
  'modmixer:mods:unsync-from-game': (folder: string) => WorkspaceMod[];
  'modmixer:mods:delete': (folder: string) => WorkspaceMod[];
  'modmixer:mods:import-from-folder': () => {
    result: ImportModResult;
    mods: WorkspaceMod[];
  } | null;
  'modmixer:mods:create-untitled': () => {
    folder: string;
    mods: WorkspaceMod[];
  };
  'modmixer:mods:read-about': (folder: string) => AboutMetadata | null;
  'modmixer:mods:read-schematic': (folder: string) => SchematicData | null;
  'modmixer:mods:scan-defs': (folder: string) => DefEntry[];
  'modmixer:mods:write-about': (
    folder: string,
    patch: Partial<AboutMetadata>,
  ) => WorkspaceMod | null;
  'modmixer:mods:write-deps': (
    folder: string,
    deps: {
      modDependencies: ModDependency[];
      loadAfter: string[];
      loadBefore: string[];
      incompatibleWith: string[];
    },
  ) => WorkspaceMod | null;
  'modmixer:mods:enable-in-game': (folder: string) => EnableResult;
  'modmixer:mods:disable-in-game': (folder: string) => DisableResult;
  'modmixer:workspace:paths': () => WorkspacePaths;

  // Game
  'modmixer:game:launch': () => {
    executable: string;
    args: string[];
    alreadyRunning: boolean;
  };
  'modmixer:game:is-running': () => boolean;
  'modmixer:game:quit': () => { killed: boolean };

  // Assets
  'modmixer:assets:scan': (folder: string) => AssetScan;
  'modmixer:assets:add': (
    folder: string,
    destRelPath: string,
    sourceAbsPath: string,
  ) => AssetScan;
  'modmixer:assets:add-slot': (
    folder: string,
    slot: AssetSlotRef,
    sourceAbsPath: string,
  ) => AssetScan;
  'modmixer:assets:set-preview-image': (
    folder: string,
    sourceAbsPath: string,
  ) => AssetScan;
  'modmixer:assets:remove': (folder: string, relPath: string) => AssetScan;
  'modmixer:assets:read-data-url': (
    folder: string,
    relPath: string,
  ) => string | null;
  'modmixer:assets:pick-file': (kind: AssetKind) => string | null;

  // Chat attachments
  'modmixer:attachments:prepare': (
    inputs: AttachmentInput[],
  ) => PreparedAttachment[];
  'modmixer:attachments:pick': () => PreparedAttachment[];
  'modmixer:assets:pick-preview-bg': () => string | null;
  'modmixer:assets:set-preview-bg': (
    folder: string,
    sourceAbsPath: string,
  ) => string;
  'modmixer:assets:clear-preview-bg': (folder: string) => void;
  'modmixer:assets:get-preview-bg': (
    folder: string,
  ) => { path: string; dataUrl: string } | null;

  // Monitor (in-game bridge)
  'modmixer:monitor:get-state': () => MonitorConnectionState;
  'modmixer:monitor:get-snapshot': () => ModsSnapshot | null;

  // Live sessions (in-game prompting)
  'modmixer:live:launch': () => LiveLaunchResult;
  'modmixer:live:get-state': () => LiveConnectionState;

  // OAuth
  'modmixer:oauth:list': () => OAuthLink[];
  'modmixer:oauth:login': (providerId: string) => void;
  'modmixer:oauth:cancel-login': () => void;
  'modmixer:oauth:provide-code': (providerId: string, value: string) => void;
  'modmixer:oauth:logout': (providerId: string) => void;

  // OpenRouter
  'modmixer:openrouter:get-config': () => OpenRouterConfig;
  'modmixer:openrouter:set-api-key': (key: string | null) => OpenRouterConfig;
  'modmixer:openrouter:add-model': (slug: string) => OpenRouterConfig;
  'modmixer:openrouter:remove-model': (slug: string) => OpenRouterConfig;
  'modmixer:openrouter:get-credits': () => OpenRouterCredits | null;

  // Local OpenAI-compatible providers (LM Studio, Ollama, vLLM, llama.cpp, …)
  'modmixer:local:list': () => LocalProvider[];
  'modmixer:local:add': (input: {
    label: string;
    baseUrl: string;
    apiKey?: string | null;
  }) => LocalProvider[];
  'modmixer:local:update': (
    id: string,
    patch: { label?: string; baseUrl?: string; apiKey?: string | null },
  ) => LocalProvider[];
  'modmixer:local:remove': (id: string) => LocalProvider[];
  'modmixer:local:add-model': (id: string, modelId: string) => LocalProvider[];
  'modmixer:local:remove-model': (
    id: string,
    modelId: string,
  ) => LocalProvider[];
  'modmixer:local:discover': (baseUrl: string) => string[];

  // Shell
  'modmixer:shell:open-external': (url: string) => void;
  'modmixer:shell:open-folder': (folder: string) => string | null;

  // Lore reveal (power-user)
  'modmixer:lore:reveal': () => string | null;

  // Index
  'modmixer:index:get-snapshot': () => IndexSnapshot;
  'modmixer:index:rebuild': (options?: { force?: boolean }) => IndexSnapshot;
  'modmixer:index:cancel': () => IndexSnapshot;

  // Workshop
  'modmixer:workshop:publish': (
    folder: string,
    visibility?: number,
    trackOnLeaderboard?: boolean,
  ) => PublishResult;
  'modmixer:workshop:unlink': (folder: string) => WorkspaceMod | null;
  'modmixer:workshop:link': (
    folder: string,
    workshopId: string,
  ) => WorkspaceMod | null;

  // Registry
  'modmixer:registry:get': () => RegistryEnvelope;
  'modmixer:registry:refresh': () => RegistryEnvelope;
  'modmixer:registry:set-active': (packageIds: string[]) => RegistryEnvelope;
  'modmixer:registry:autosort': () => AutosortResult;
  'modmixer:registry:apply-autosort': () => {
    envelope: RegistryEnvelope;
    conflicts: AutosortResult['conflicts'];
  };
  'modmixer:registry:enable-with-deps': (
    packageId: string,
  ) => EnableWithDepsResult;
  'modmixer:registry:community-rules': () => CommunityRulesInfo;
  'modmixer:registry:refresh-community-rules': () => CommunityRulesInfo;

  // Saves (snapshots)
  'modmixer:snapshots:list': (folder: string) => SaveRecord[];
  'modmixer:snapshots:save': (
    folder: string,
    label: string | null,
  ) => SaveRecord | null;
  'modmixer:snapshots:rename': (
    folder: string,
    sha: string,
    label: string | null,
  ) => SaveRecord | null;
  'modmixer:snapshots:delete': (folder: string, sha: string) => void;
  'modmixer:snapshots:restore': (folder: string, sha: string) => {
    mods: WorkspaceMod[];
    hydrated: HydratedConversation | null;
  };

  // Sessions
  'modmixer:session:get-active': () => ActiveSession | null;
  'modmixer:session:start-test': (args: {
    folder: string;
    packageId: string;
  }) => {
    session: ActiveSession;
    testSet: { reducedActive: string[]; missing: string[] };
    envelope: RegistryEnvelope;
  };
  'modmixer:session:start-fix': () => {
    session: ActiveSession;
    envelope: RegistryEnvelope;
  };
  'modmixer:session:apply': () => { envelope: RegistryEnvelope };
  'modmixer:session:revert': () => { envelope: RegistryEnvelope };
  'modmixer:session:diff': () => ActiveDiff | null;
}

/**
 * One-way main → renderer broadcast channels (no reply expected). The
 * value type is the payload sent.
 */
export interface Events {
  'modmixer:agent:event': AgentEventEnvelope;
  'modmixer:agent:scope-upgraded': ScopeUpgradedEnvelope;
  'modmixer:assets:changed': AssetsChangedEnvelope;
  'modmixer:mod:changed': ModChangedEnvelope;
  'modmixer:registry:changed': RegistryEnvelope;
  'modmixer:session:changed': ActiveSession | null;
  'modmixer:monitor:state': MonitorConnectionState;
  'modmixer:monitor:message': BridgeMessage;
  'modmixer:live:state': LiveConnectionState;
  'modmixer:workshop:progress': PublishProgressEvent;
  'modmixer:snapshots:changed': SnapshotsChangedEvent;
  'modmixer:oauth:event': OAuthEvent;
  'modmixer:confirm:request': ConfirmationRequest;
  'modmixer:index:progress': IndexProgressEvent;
  'modmixer:updater:state': UpdaterState;
  /** Main asks the renderer to confirm a pending quit (payload-less). */
  'modmixer:quit:requested': void;
}

type ChannelArgs<K extends keyof Channels> = Parameters<Channels[K]>;
type ChannelReturn<K extends keyof Channels> = Awaited<ReturnType<Channels[K]>>;

/** Typed wrapper around `ipcRenderer.invoke`. */
export function invoke<K extends keyof Channels>(
  channel: K,
  ...args: ChannelArgs<K>
): Promise<ChannelReturn<K>> {
  return ipcRenderer.invoke(channel, ...args);
}

/** Subscribe to a one-way main→renderer broadcast. Returns an unsubscribe. */
export function on<K extends keyof Events>(
  channel: K,
  handler: (payload: Events[K]) => void,
): () => void {
  const wrapped = (_e: IpcRendererEvent, payload: Events[K]) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}
