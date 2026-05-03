import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type {
  Consent,
  ModelSelection,
  OnboardingState,
  Settings,
  ThemePreference,
} from './agent/settings';
import type { EnvSnapshot } from './agent/env-detect';
import type { ModelOption } from './agent/models';
import type { OAuthEvent, OAuthLink } from './agent/agent-host';
import type {
  Conversation,
  ConversationScope,
} from './agent/conversations';
import type {
  AboutMetadata,
  WorkspaceMod,
  WorkspacePaths,
} from './agent/workspace';
import type { SchematicData } from './agent/schematic';
import type { DefEntry } from './agent/defs-scan';
import type { DefGraph } from './agent/def-graph';
import type { EnableResult, DisableResult } from './agent/game';
import type { AssetKind, AssetScan } from './agent/assets/types';
import type {
  BridgeMessage,
  ModsSnapshot,
  MonitorConnectionState,
} from './agent/monitor/protocol';
import type {
  PublishProgressEvent,
  PublishResult,
} from './agent/workshop';
import type { ConfirmationRequest } from './agent/security/confirmation-gate';
import type {
  IndexSnapshot,
} from './agent/index/main-bridge';
import type { IndexProgressEvent } from './agent/index/progress';
import type {
  RegistrySnapshot,
  AnalysisResult,
  AutosortResult,
  AutosortConflict,
  ActiveSession,
  ActiveDiff,
} from './agent/registry';
export interface AssetsChangedEnvelope {
  folder: string;
}

export interface EnableWithDepsResult {
  envelope: RegistryEnvelope;
  /** Lowercased packageIds newly added to <activeMods> (target + deps). */
  added: string[];
  /** Declared deps that aren't installed on disk. */
  missing: string[];
  /** True if the target packageId was already in <activeMods>. */
  alreadyActive: boolean;
  conflicts: AutosortConflict[];
}

export interface ModChangedEnvelope {
  folder: string;
}

export interface AgentEventEnvelope {
  conversationId: string | null;
  event: AgentSessionEvent;
}

export interface HydratedConversation {
  conversation: Conversation;
  messages: AgentMessage[];
}

export interface ScopeUpgradedEnvelope {
  conversationId: string;
  scope: ConversationScope;
}

export interface RegistryEnvelope {
  snapshot: RegistrySnapshot;
  analysis: AnalysisResult;
}

export interface CommunityRulesInfo {
  fetchedAt: string | null;
  source: 'cache' | 'fetched' | 'bundled' | 'empty';
  count: number;
  rules?: Record<string, unknown>;
}

const api = {
  // App
  getAppVersion(): Promise<string> {
    return ipcRenderer.invoke('modmixer:app:version');
  },

  // Consent
  getConsentStatus(): Promise<{
    required: string;
    accepted: Consent | null;
  }> {
    return ipcRenderer.invoke('modmixer:consent:get');
  },
  acceptConsent(options?: { analyticsOptIn?: boolean }): Promise<Settings> {
    return ipcRenderer.invoke('modmixer:consent:accept', options);
  },

  // Onboarding
  getOnboardingStatus(): Promise<{
    required: string;
    completed: OnboardingState | null;
    shouldShow: boolean;
  }> {
    return ipcRenderer.invoke('modmixer:onboarding:get-status');
  },
  completeOnboarding(): Promise<Settings> {
    return ipcRenderer.invoke('modmixer:onboarding:complete');
  },
  resetOnboarding(): Promise<Settings> {
    return ipcRenderer.invoke('modmixer:onboarding:reset');
  },
  detectEnv(): Promise<EnvSnapshot> {
    return ipcRenderer.invoke('modmixer:env:detect');
  },
  browseRimWorldInstall(): Promise<string | null> {
    return ipcRenderer.invoke('modmixer:env:browse-rimworld-install');
  },
  clearRimWorldInstallOverride(): Promise<null> {
    return ipcRenderer.invoke('modmixer:env:clear-rimworld-install-override');
  },

  // Agent
  send(text: string): Promise<void> {
    return ipcRenderer.invoke('modmixer:agent:send', text);
  },
  interrupt(): Promise<void> {
    return ipcRenderer.invoke('modmixer:agent:interrupt');
  },
  onEvent(handler: (envelope: AgentEventEnvelope) => void): () => void {
    const wrapped = (_e: unknown, env: AgentEventEnvelope) => handler(env);
    ipcRenderer.on('modmixer:agent:event', wrapped);
    return () => ipcRenderer.off('modmixer:agent:event', wrapped);
  },
  onScopeUpgraded(
    handler: (env: ScopeUpgradedEnvelope) => void,
  ): () => void {
    const wrapped = (_e: unknown, env: ScopeUpgradedEnvelope) => handler(env);
    ipcRenderer.on('modmixer:agent:scope-upgraded', wrapped);
    return () =>
      ipcRenderer.off('modmixer:agent:scope-upgraded', wrapped);
  },

  // Settings
  getSettings(): Promise<Settings> {
    return ipcRenderer.invoke('modmixer:settings:get');
  },
  setModel(selection: ModelSelection): Promise<Settings> {
    return ipcRenderer.invoke('modmixer:settings:set-model', selection);
  },
  setDefaultAuthor(author: string): Promise<Settings> {
    return ipcRenderer.invoke('modmixer:settings:set-default-author', author);
  },
  setAnalyticsOptIn(optIn: boolean): Promise<Settings> {
    return ipcRenderer.invoke('modmixer:settings:set-analytics-opt-in', optIn);
  },
  setTheme(theme: ThemePreference): Promise<Settings> {
    return ipcRenderer.invoke('modmixer:settings:set-theme', theme);
  },
  listModels(): Promise<ModelOption[]> {
    return ipcRenderer.invoke('modmixer:models:list');
  },

  // Conversations
  listConversations(): Promise<Conversation[]> {
    return ipcRenderer.invoke('modmixer:conversations:list');
  },
  createConversation(
    scope: ConversationScope,
    title?: string,
  ): Promise<Conversation> {
    return ipcRenderer.invoke(
      'modmixer:conversations:create',
      scope,
      title,
    );
  },
  switchConversation(id: string): Promise<HydratedConversation> {
    return ipcRenderer.invoke('modmixer:conversations:switch', id);
  },
  deleteConversation(id: string): Promise<void> {
    return ipcRenderer.invoke('modmixer:conversations:delete', id);
  },
  getActiveConversationId(): Promise<string | null> {
    return ipcRenderer.invoke('modmixer:conversations:get-active');
  },
  getActiveMessages(): Promise<AgentMessage[]> {
    return ipcRenderer.invoke('modmixer:conversations:get-active-messages');
  },
  /**
   * Resolve to the "active chat" for a mod, creating one if none exists.
   * Switches the agent to it as a side-effect.
   */
  openConversationForMod(folder: string): Promise<HydratedConversation> {
    return ipcRenderer.invoke(
      'modmixer:conversations:open-for-mod',
      folder,
    );
  },
  /**
   * Replace the active chat for a mod with a fresh one. The previous chat's
   * session file is left on disk.
   */
  startFreshChatForMod(folder: string): Promise<HydratedConversation> {
    return ipcRenderer.invoke(
      'modmixer:conversations:start-fresh-for-mod',
      folder,
    );
  },

  // Mods (workspace)
  listWorkspaceMods(): Promise<WorkspaceMod[]> {
    return ipcRenderer.invoke('modmixer:mods:list-workspace');
  },
  syncModToGame(folder: string): Promise<WorkspaceMod[]> {
    return ipcRenderer.invoke('modmixer:mods:sync-to-game', folder);
  },
  unsyncModFromGame(folder: string): Promise<WorkspaceMod[]> {
    return ipcRenderer.invoke('modmixer:mods:unsync-from-game', folder);
  },
  deleteMod(folder: string): Promise<WorkspaceMod[]> {
    return ipcRenderer.invoke('modmixer:mods:delete', folder);
  },
  readModAbout(folder: string): Promise<AboutMetadata | null> {
    return ipcRenderer.invoke('modmixer:mods:read-about', folder);
  },
  readSchematic(folder: string): Promise<SchematicData | null> {
    return ipcRenderer.invoke('modmixer:mods:read-schematic', folder);
  },
  scanModDefs(folder: string): Promise<DefEntry[]> {
    return ipcRenderer.invoke('modmixer:mods:scan-defs', folder);
  },
  getDefGraph(folder: string): Promise<DefGraph> {
    return ipcRenderer.invoke('modmixer:mods:def-graph', folder);
  },
  writeModAbout(
    folder: string,
    patch: Partial<AboutMetadata>,
  ): Promise<WorkspaceMod | null> {
    return ipcRenderer.invoke('modmixer:mods:write-about', folder, patch);
  },
  onModChanged(handler: (env: ModChangedEnvelope) => void): () => void {
    const wrapped = (_e: unknown, env: ModChangedEnvelope) => handler(env);
    ipcRenderer.on('modmixer:mod:changed', wrapped);
    return () => ipcRenderer.off('modmixer:mod:changed', wrapped);
  },
  getWorkspacePaths(): Promise<WorkspacePaths> {
    return ipcRenderer.invoke('modmixer:workspace:paths');
  },
  enableModInGame(folder: string): Promise<EnableResult> {
    return ipcRenderer.invoke('modmixer:mods:enable-in-game', folder);
  },
  disableModInGame(folder: string): Promise<DisableResult> {
    return ipcRenderer.invoke('modmixer:mods:disable-in-game', folder);
  },
  launchRimWorld(): Promise<{ url: string; command: string; alreadyRunning: boolean }> {
    return ipcRenderer.invoke('modmixer:game:launch');
  },
  isRimWorldRunning(): Promise<boolean> {
    return ipcRenderer.invoke('modmixer:game:is-running');
  },
  quitRimWorld(): Promise<{ killed: boolean }> {
    return ipcRenderer.invoke('modmixer:game:quit');
  },

  // Assets
  scanAssets(folder: string): Promise<AssetScan> {
    return ipcRenderer.invoke('modmixer:assets:scan', folder);
  },
  addAsset(
    folder: string,
    destRelPath: string,
    sourceAbsPath: string,
  ): Promise<AssetScan> {
    return ipcRenderer.invoke(
      'modmixer:assets:add',
      folder,
      destRelPath,
      sourceAbsPath,
    );
  },
  removeAsset(folder: string, relPath: string): Promise<AssetScan> {
    return ipcRenderer.invoke('modmixer:assets:remove', folder, relPath);
  },
  pickAssetFile(kind: AssetKind): Promise<string | null> {
    return ipcRenderer.invoke('modmixer:assets:pick-file', kind);
  },
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
  readAssetDataUrl(
    folder: string,
    relPath: string,
  ): Promise<string | null> {
    return ipcRenderer.invoke(
      'modmixer:assets:read-data-url',
      folder,
      relPath,
    );
  },
  onAssetsChanged(handler: (env: AssetsChangedEnvelope) => void): () => void {
    const wrapped = (_e: unknown, env: AssetsChangedEnvelope) => handler(env);
    ipcRenderer.on('modmixer:assets:changed', wrapped);
    return () => ipcRenderer.off('modmixer:assets:changed', wrapped);
  },

  // Monitor (in-game bridge)
  getMonitorState(): Promise<MonitorConnectionState> {
    return ipcRenderer.invoke('modmixer:monitor:get-state');
  },
  getMonitorSnapshot(): Promise<ModsSnapshot | null> {
    return ipcRenderer.invoke('modmixer:monitor:get-snapshot');
  },
  onMonitorState(
    handler: (state: MonitorConnectionState) => void,
  ): () => void {
    const wrapped = (_e: unknown, s: MonitorConnectionState) => handler(s);
    ipcRenderer.on('modmixer:monitor:state', wrapped);
    return () => ipcRenderer.off('modmixer:monitor:state', wrapped);
  },
  onMonitorMessage(handler: (msg: BridgeMessage) => void): () => void {
    const wrapped = (_e: unknown, m: BridgeMessage) => handler(m);
    ipcRenderer.on('modmixer:monitor:message', wrapped);
    return () => ipcRenderer.off('modmixer:monitor:message', wrapped);
  },

  // OAuth (multi-provider sign-in via pi-mono)
  listOAuthLinks(): Promise<OAuthLink[]> {
    return ipcRenderer.invoke('modmixer:oauth:list');
  },
  loginOAuth(providerId: string): Promise<void> {
    return ipcRenderer.invoke('modmixer:oauth:login', providerId);
  },
  cancelOAuthLogin(): Promise<void> {
    return ipcRenderer.invoke('modmixer:oauth:cancel-login');
  },
  provideOAuthCode(providerId: string, value: string): Promise<void> {
    return ipcRenderer.invoke('modmixer:oauth:provide-code', providerId, value);
  },
  logoutOAuth(providerId: string): Promise<void> {
    return ipcRenderer.invoke('modmixer:oauth:logout', providerId);
  },
  onOAuthEvent(handler: (event: OAuthEvent) => void): () => void {
    const wrapped = (_e: unknown, event: OAuthEvent) => handler(event);
    ipcRenderer.on('modmixer:oauth:event', wrapped);
    return () => ipcRenderer.off('modmixer:oauth:event', wrapped);
  },

  // Shell
  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke('modmixer:shell:open-external', url);
  },

  // Lore (power-user reveal)
  revealLoreDir(args: {
    tier: 'user' | 'mod';
    modFolder?: string;
  }): Promise<string | null> {
    return ipcRenderer.invoke('modmixer:lore:reveal', args);
  },

  // Confirmation gate (sensitive agent actions)
  onConfirmRequest(handler: (req: ConfirmationRequest) => void): () => void {
    const wrapped = (_e: unknown, req: ConfirmationRequest) => handler(req);
    ipcRenderer.on('modmixer:confirm:request', wrapped);
    return () => ipcRenderer.off('modmixer:confirm:request', wrapped);
  },
  resolveConfirm(
    id: string,
    approved: boolean,
    alwaysAllowForSession = false,
  ): void {
    ipcRenderer.send('modmixer:confirm:resolve', {
      id,
      approved,
      alwaysAllowForSession,
    });
  },

  // RimWorld source/def index
  getIndexSnapshot(): Promise<IndexSnapshot> {
    return ipcRenderer.invoke('modmixer:index:get-snapshot');
  },
  rebuildIndex(options: { force?: boolean } = {}): Promise<IndexSnapshot> {
    return ipcRenderer.invoke('modmixer:index:rebuild', options);
  },
  cancelIndexRebuild(): Promise<IndexSnapshot> {
    return ipcRenderer.invoke('modmixer:index:cancel');
  },
  onIndexProgress(handler: (event: IndexProgressEvent) => void): () => void {
    const wrapped = (_e: unknown, event: IndexProgressEvent) => handler(event);
    ipcRenderer.on('modmixer:index:progress', wrapped);
    return () => ipcRenderer.off('modmixer:index:progress', wrapped);
  },

  // Workshop
  publishToWorkshop(folder: string): Promise<PublishResult> {
    return ipcRenderer.invoke('modmixer:workshop:publish', folder);
  },
  onWorkshopProgress(
    handler: (event: PublishProgressEvent) => void,
  ): () => void {
    const wrapped = (_e: unknown, event: PublishProgressEvent) => handler(event);
    ipcRenderer.on('modmixer:workshop:progress', wrapped);
    return () => ipcRenderer.off('modmixer:workshop:progress', wrapped);
  },

  // Mod registry — full system view (DLCs + local + workshop + workspace).
  getRegistry(): Promise<RegistryEnvelope> {
    return ipcRenderer.invoke('modmixer:registry:get');
  },
  refreshRegistry(): Promise<RegistryEnvelope> {
    return ipcRenderer.invoke('modmixer:registry:refresh');
  },
  setActiveMods(packageIds: string[]): Promise<RegistryEnvelope> {
    return ipcRenderer.invoke('modmixer:registry:set-active', packageIds);
  },
  autosortMods(): Promise<AutosortResult> {
    return ipcRenderer.invoke('modmixer:registry:autosort');
  },
  applyAutosort(): Promise<{
    envelope: RegistryEnvelope;
    conflicts: AutosortResult['conflicts'];
  }> {
    return ipcRenderer.invoke('modmixer:registry:apply-autosort');
  },
  enableWithDeps(packageId: string): Promise<EnableWithDepsResult> {
    return ipcRenderer.invoke('modmixer:registry:enable-with-deps', packageId);
  },
  getCommunityRulesInfo(): Promise<CommunityRulesInfo> {
    return ipcRenderer.invoke('modmixer:registry:community-rules');
  },
  refreshCommunityRules(): Promise<CommunityRulesInfo> {
    return ipcRenderer.invoke('modmixer:registry:refresh-community-rules');
  },
  onRegistryChanged(
    handler: (env: RegistryEnvelope) => void,
  ): () => void {
    const wrapped = (_e: unknown, env: RegistryEnvelope) => handler(env);
    ipcRenderer.on('modmixer:registry:changed', wrapped);
    return () => ipcRenderer.off('modmixer:registry:changed', wrapped);
  },

  // Sessions — snapshot-restore for test mode and fix mode.
  getActiveSession(): Promise<ActiveSession | null> {
    return ipcRenderer.invoke('modmixer:session:get-active');
  },
  startTestSession(args: {
    folder: string;
    packageId: string;
  }): Promise<{
    session: ActiveSession;
    testSet: { reducedActive: string[]; missing: string[] };
    envelope: RegistryEnvelope;
  }> {
    return ipcRenderer.invoke('modmixer:session:start-test', args);
  },
  startFixSession(): Promise<{
    session: ActiveSession;
    envelope: RegistryEnvelope;
  }> {
    return ipcRenderer.invoke('modmixer:session:start-fix');
  },
  applySession(): Promise<{ envelope: RegistryEnvelope }> {
    return ipcRenderer.invoke('modmixer:session:apply');
  },
  revertSession(): Promise<{ envelope: RegistryEnvelope }> {
    return ipcRenderer.invoke('modmixer:session:revert');
  },
  getSessionDiff(): Promise<ActiveDiff | null> {
    return ipcRenderer.invoke('modmixer:session:diff');
  },
  onSessionChanged(
    handler: (session: ActiveSession | null) => void,
  ): () => void {
    const wrapped = (_e: unknown, session: ActiveSession | null) =>
      handler(session);
    ipcRenderer.on('modmixer:session:changed', wrapped);
    return () => ipcRenderer.off('modmixer:session:changed', wrapped);
  },

  // Workspace mod deps — write-side helper for the UI dep editor.
  writeModDeps(
    folder: string,
    deps: {
      modDependencies: import('./agent/registry').ModDependency[];
      loadAfter: string[];
      loadBefore: string[];
      incompatibleWith: string[];
    },
  ): Promise<WorkspaceMod | null> {
    return ipcRenderer.invoke('modmixer:mods:write-deps', folder, deps);
  },
};

contextBridge.exposeInMainWorld('modmixer', api);

export type ModMixerApi = typeof api;
