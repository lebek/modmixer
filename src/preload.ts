import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { invoke, on } from './preload/typed-ipc.js';

// Re-export envelope types so renderer modules can keep importing them
// from `./preload`.
export type {
  AgentEventEnvelope,
  AssetsChangedEnvelope,
  CommunityRulesInfo,
  EnableWithDepsResult,
  HydratedConversation,
  ModChangedEnvelope,
  RegistryEnvelope,
  ScopeUpgradedEnvelope,
} from './preload/typed-ipc.js';

const api = {
  // App
  getAppVersion: () => invoke('modmixer:app:version'),

  // Updater
  getUpdaterState: () => invoke('modmixer:updater:get-state'),
  checkForUpdates: () => invoke('modmixer:updater:check'),
  quitAndInstallUpdate: () => invoke('modmixer:updater:quit-and-install'),
  onUpdaterState: (handler: (state: import('./agent/updater').UpdaterState) => void) =>
    on('modmixer:updater:state', handler),

  // Consent
  getConsentStatus: () => invoke('modmixer:consent:get'),
  acceptConsent: (options?: { analyticsOptIn?: boolean }) =>
    invoke('modmixer:consent:accept', options),

  // Onboarding
  getOnboardingStatus: () => invoke('modmixer:onboarding:get-status'),
  completeOnboarding: () => invoke('modmixer:onboarding:complete'),
  resetOnboarding: () => invoke('modmixer:onboarding:reset'),
  detectEnv: () => invoke('modmixer:env:detect'),
  browseRimWorldInstall: () => invoke('modmixer:env:browse-rimworld-install'),
  clearRimWorldInstallOverride: () =>
    invoke('modmixer:env:clear-rimworld-install-override'),

  // Agent
  send: (
    conversationId: string,
    text: string,
    attachments?: import('./agent/attachments/types').PreparedAttachment[],
  ) => invoke('modmixer:agent:send', conversationId, text, attachments),
  interrupt: (conversationId: string) =>
    invoke('modmixer:agent:interrupt', conversationId),
  closeConversation: (conversationId: string) =>
    invoke('modmixer:agent:close', conversationId),
  releaseIdleConversation: (conversationId: string) =>
    invoke('modmixer:agent:release-idle', conversationId),
  getContextUsage: (conversationId: string) =>
    invoke('modmixer:agent:get-context-usage', conversationId),
  onEvent: (handler: (env: import('./preload/typed-ipc').AgentEventEnvelope) => void) =>
    on('modmixer:agent:event', handler),
  onScopeUpgraded: (
    handler: (env: import('./preload/typed-ipc').ScopeUpgradedEnvelope) => void,
  ) => on('modmixer:agent:scope-upgraded', handler),

  // Settings
  getSettings: () => invoke('modmixer:settings:get'),
  setModel: (selection: import('./agent/settings').ModelSelection) =>
    invoke('modmixer:settings:set-model', selection),
  setDefaultAuthor: (author: string) =>
    invoke('modmixer:settings:set-default-author', author),
  setAnalyticsOptIn: (optIn: boolean) =>
    invoke('modmixer:settings:set-analytics-opt-in', optIn),
  setTheme: (theme: import('./agent/settings').ThemePreference) =>
    invoke('modmixer:settings:set-theme', theme),
  setThinkingLevel: (level: import('@mariozechner/pi-agent-core').ThinkingLevel) =>
    invoke('modmixer:settings:set-thinking-level', level),
  setMultiChat: (enabled: boolean) =>
    invoke('modmixer:settings:set-multi-chat', enabled),
  setCommunityLore: (enabled: boolean) =>
    invoke('modmixer:settings:set-community-lore', enabled),
  listModels: () => invoke('modmixer:models:list'),

  // Conversations
  listConversations: () => invoke('modmixer:conversations:list'),
  listConversationsForMod: (folder: string) =>
    invoke('modmixer:conversations:list-for-mod', folder),
  archiveConversation: (id: string) =>
    invoke('modmixer:conversations:archive', id),
  unarchiveConversation: (id: string) =>
    invoke('modmixer:conversations:unarchive', id),
  setActiveConversationForMod: (folder: string, id: string) =>
    invoke('modmixer:conversations:set-active-for-mod', folder, id),
  createConversation: (
    scope: import('./agent/conversations').ConversationScope,
    title?: string,
  ) => invoke('modmixer:conversations:create', scope, title),
  deleteConversation: (id: string) => invoke('modmixer:conversations:delete', id),
  setConversationModel: (
    conversationId: string,
    selection: import('./agent/settings').ModelSelection,
  ) => invoke('modmixer:conversations:set-model', conversationId, selection),
  setConversationThinkingLevel: (
    conversationId: string,
    level: import('@mariozechner/pi-agent-core').ThinkingLevel,
  ) =>
    invoke('modmixer:conversations:set-thinking-level', conversationId, level),
  /**
   * Resolve the "active chat" for a mod to a Conversation (creating one if
   * none exists) — fast, no session construction. Pair with
   * openConversationSession to load the transcript in the background.
   */
  resolveConversationForMod: (folder: string) =>
    invoke('modmixer:conversations:resolve-for-mod', folder),
  /** Open a conversation's agent session and return its hydrated transcript. */
  openConversationSession: (conversationId: string) =>
    invoke('modmixer:conversations:open-session', conversationId),
  /**
   * Replace the active chat for a mod with a fresh one. The previous chat's
   * session file is left on disk.
   */
  startFreshChatForMod: (folder: string) =>
    invoke('modmixer:conversations:start-fresh-for-mod', folder),

  // Mods (workspace)
  listWorkspaceMods: () => invoke('modmixer:mods:list-workspace'),
  syncModToGame: (folder: string) => invoke('modmixer:mods:sync-to-game', folder),
  unsyncModFromGame: (folder: string) =>
    invoke('modmixer:mods:unsync-from-game', folder),
  deleteMod: (folder: string) => invoke('modmixer:mods:delete', folder),
  importModFromFolder: () => invoke('modmixer:mods:import-from-folder'),
  createUntitledMod: () => invoke('modmixer:mods:create-untitled'),
  readModAbout: (folder: string) => invoke('modmixer:mods:read-about', folder),
  readSchematic: (folder: string) => invoke('modmixer:mods:read-schematic', folder),
  scanModDefs: (folder: string) => invoke('modmixer:mods:scan-defs', folder),
  writeModAbout: (
    folder: string,
    patch: Partial<import('./agent/workspace').AboutMetadata>,
  ) => invoke('modmixer:mods:write-about', folder, patch),
  onModChanged: (
    handler: (env: import('./preload/typed-ipc').ModChangedEnvelope) => void,
  ) => on('modmixer:mod:changed', handler),
  getWorkspacePaths: () => invoke('modmixer:workspace:paths'),
  enableModInGame: (folder: string) =>
    invoke('modmixer:mods:enable-in-game', folder),
  disableModInGame: (folder: string) =>
    invoke('modmixer:mods:disable-in-game', folder),
  launchRimWorld: () => invoke('modmixer:game:launch'),
  isRimWorldRunning: () => invoke('modmixer:game:is-running'),
  quitRimWorld: () => invoke('modmixer:game:quit'),

  // Assets
  scanAssets: (folder: string) => invoke('modmixer:assets:scan', folder),
  addAsset: (folder: string, destRelPath: string, sourceAbsPath: string) =>
    invoke('modmixer:assets:add', folder, destRelPath, sourceAbsPath),
  addSlotFile: (
    folder: string,
    slot: import('./agent/assets/types').AssetSlotRef,
    sourceAbsPath: string,
  ) => invoke('modmixer:assets:add-slot', folder, slot, sourceAbsPath),
  setPreviewImage: (folder: string, sourceAbsPath: string) =>
    invoke('modmixer:assets:set-preview-image', folder, sourceAbsPath),
  removeAsset: (folder: string, relPath: string) =>
    invoke('modmixer:assets:remove', folder, relPath),
  pickAssetFile: (kind: import('./agent/assets/types').AssetKind) =>
    invoke('modmixer:assets:pick-file', kind),

  // Chat attachments
  prepareAttachments: (
    inputs: import('./agent/attachments/types').AttachmentInput[],
  ) => invoke('modmixer:attachments:prepare', inputs),
  pickAttachments: () => invoke('modmixer:attachments:pick'),
  pickPreviewBg: () => invoke('modmixer:assets:pick-preview-bg'),
  setPreviewBg: (folder: string, sourceAbsPath: string) =>
    invoke('modmixer:assets:set-preview-bg', folder, sourceAbsPath),
  clearPreviewBg: (folder: string) =>
    invoke('modmixer:assets:clear-preview-bg', folder),
  getPreviewBg: (folder: string) =>
    invoke('modmixer:assets:get-preview-bg', folder),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  readAssetDataUrl: (folder: string, relPath: string) =>
    invoke('modmixer:assets:read-data-url', folder, relPath),
  onAssetsChanged: (
    handler: (env: import('./preload/typed-ipc').AssetsChangedEnvelope) => void,
  ) => on('modmixer:assets:changed', handler),

  // Monitor (in-game bridge)
  getMonitorState: () => invoke('modmixer:monitor:get-state'),
  getMonitorSnapshot: () => invoke('modmixer:monitor:get-snapshot'),
  onMonitorState: (
    handler: (state: import('./agent/monitor/protocol').MonitorConnectionState) => void,
  ) => on('modmixer:monitor:state', handler),
  onMonitorMessage: (
    handler: (msg: import('./agent/monitor/protocol').BridgeMessage) => void,
  ) => on('modmixer:monitor:message', handler),

  // OAuth
  listOAuthLinks: () => invoke('modmixer:oauth:list'),
  loginOAuth: (providerId: string) => invoke('modmixer:oauth:login', providerId),
  cancelOAuthLogin: () => invoke('modmixer:oauth:cancel-login'),
  provideOAuthCode: (providerId: string, value: string) =>
    invoke('modmixer:oauth:provide-code', providerId, value),
  logoutOAuth: (providerId: string) => invoke('modmixer:oauth:logout', providerId),
  onOAuthEvent: (
    handler: (event: import('./agent/agent-host').OAuthEvent) => void,
  ) => on('modmixer:oauth:event', handler),

  // OpenRouter
  getOpenRouterConfig: () => invoke('modmixer:openrouter:get-config'),
  setOpenRouterApiKey: (key: string | null) =>
    invoke('modmixer:openrouter:set-api-key', key),
  addOpenRouterModel: (slug: string) =>
    invoke('modmixer:openrouter:add-model', slug),
  removeOpenRouterModel: (slug: string) =>
    invoke('modmixer:openrouter:remove-model', slug),
  getOpenRouterCredits: () => invoke('modmixer:openrouter:get-credits'),

  // Local OpenAI-compatible providers
  listLocalProviders: () => invoke('modmixer:local:list'),
  addLocalProvider: (input: {
    label: string;
    baseUrl: string;
    apiKey?: string | null;
  }) => invoke('modmixer:local:add', input),
  updateLocalProvider: (
    id: string,
    patch: { label?: string; baseUrl?: string; apiKey?: string | null },
  ) => invoke('modmixer:local:update', id, patch),
  removeLocalProvider: (id: string) => invoke('modmixer:local:remove', id),
  addLocalModel: (id: string, modelId: string) =>
    invoke('modmixer:local:add-model', id, modelId),
  removeLocalModel: (id: string, modelId: string) =>
    invoke('modmixer:local:remove-model', id, modelId),
  discoverLocalModels: (baseUrl: string) =>
    invoke('modmixer:local:discover', baseUrl),

  // Shell
  openExternal: (url: string) => invoke('modmixer:shell:open-external', url),
  openFolder: (folder: string) => invoke('modmixer:shell:open-folder', folder),

  // Lore (power-user reveal)
  revealLoreDir: () => invoke('modmixer:lore:reveal'),

  // Confirmation gate (sensitive agent actions)
  onConfirmRequest: (
    handler: (req: import('./agent/security/confirmation-gate').ConfirmationRequest) => void,
  ) => on('modmixer:confirm:request', handler),
  resolveConfirm: (id: string, approved: boolean, alwaysAllowForSession = false) => {
    ipcRenderer.send('modmixer:confirm:resolve', {
      id,
      approved,
      alwaysAllowForSession,
    });
  },

  // RimWorld source/def index
  getIndexSnapshot: () => invoke('modmixer:index:get-snapshot'),
  rebuildIndex: (options: { force?: boolean } = {}) =>
    invoke('modmixer:index:rebuild', options),
  cancelIndexRebuild: () => invoke('modmixer:index:cancel'),
  onIndexProgress: (
    handler: (event: import('./agent/index/progress').IndexProgressEvent) => void,
  ) => on('modmixer:index:progress', handler),

  // Workshop
  publishToWorkshop: (folder: string) =>
    invoke('modmixer:workshop:publish', folder),
  unlinkWorkshopItem: (folder: string) =>
    invoke('modmixer:workshop:unlink', folder),
  linkWorkshopItem: (folder: string, workshopId: string) =>
    invoke('modmixer:workshop:link', folder, workshopId),
  onWorkshopProgress: (
    handler: (event: import('./agent/workshop').PublishProgressEvent) => void,
  ) => on('modmixer:workshop:progress', handler),

  // Mod registry — full system view (DLCs + local + workshop + workspace).
  getRegistry: () => invoke('modmixer:registry:get'),
  refreshRegistry: () => invoke('modmixer:registry:refresh'),
  setActiveMods: (packageIds: string[]) =>
    invoke('modmixer:registry:set-active', packageIds),
  autosortMods: () => invoke('modmixer:registry:autosort'),
  applyAutosort: () => invoke('modmixer:registry:apply-autosort'),
  enableWithDeps: (packageId: string) =>
    invoke('modmixer:registry:enable-with-deps', packageId),
  getCommunityRulesInfo: () => invoke('modmixer:registry:community-rules'),
  refreshCommunityRules: () => invoke('modmixer:registry:refresh-community-rules'),
  onRegistryChanged: (
    handler: (env: import('./preload/typed-ipc').RegistryEnvelope) => void,
  ) => on('modmixer:registry:changed', handler),

  // Saves (snapshots) — rollback for the active mod's history.
  listSnapshots: (folder: string) =>
    invoke('modmixer:snapshots:list', folder),
  saveSnapshot: (folder: string, label: string | null) =>
    invoke('modmixer:snapshots:save', folder, label),
  renameSnapshot: (folder: string, sha: string, label: string | null) =>
    invoke('modmixer:snapshots:rename', folder, sha, label),
  deleteSnapshot: (folder: string, sha: string) =>
    invoke('modmixer:snapshots:delete', folder, sha),
  restoreSnapshot: (folder: string, sha: string) =>
    invoke('modmixer:snapshots:restore', folder, sha),
  onSnapshotsChanged: (
    handler: (event: import('./agent/snapshots').SnapshotsChangedEvent) => void,
  ) => on('modmixer:snapshots:changed', handler),

  // Sessions — snapshot-restore for test mode and fix mode.
  getActiveSession: () => invoke('modmixer:session:get-active'),
  startTestSession: (args: { folder: string; packageId: string }) =>
    invoke('modmixer:session:start-test', args),
  startFixSession: () => invoke('modmixer:session:start-fix'),
  applySession: () => invoke('modmixer:session:apply'),
  revertSession: () => invoke('modmixer:session:revert'),
  getSessionDiff: () => invoke('modmixer:session:diff'),
  onSessionChanged: (
    handler: (session: import('./agent/registry').ActiveSession | null) => void,
  ) => on('modmixer:session:changed', handler),

  // Workspace mod deps — write-side helper for the UI dep editor.
  writeModDeps: (
    folder: string,
    deps: {
      modDependencies: import('./agent/registry').ModDependency[];
      loadAfter: string[];
      loadBefore: string[];
      incompatibleWith: string[];
    },
  ) => invoke('modmixer:mods:write-deps', folder, deps),
};

contextBridge.exposeInMainWorld('modmixer', api);

export type ModMixerApi = typeof api;
