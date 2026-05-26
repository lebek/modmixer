import type { ThinkingLevel } from '@mariozechner/pi-agent-core';
import {
  loadSettings,
  saveSettings,
  type ModelSelection,
  type ThemePreference,
} from '../../agent/settings.js';
import { setAnalyticsOptIn } from '../../agent/telemetry.js';
import {
  clearCommunityLore,
  seedCommunityLoreFromShipped,
} from '../../agent/lore.js';
import { syncCommunityLore } from '../../agent/community-lore-sync.js';
import type { RouteContext } from './context.js';

/**
 * Settings I/O + the model picker + every OAuth/OpenRouter handler. They
 * share state through AgentHost so they live together.
 */
export function registerSettingsRoutes(ctx: RouteContext): void {
  const { ipc, host } = ctx;

  ipc.handle('modmixer:settings:get', () => loadSettings());

  ipc.handle(
    'modmixer:settings:set-model',
    (_evt, selection: ModelSelection) => {
      // The default model for NEW chats only. Existing chats carry their own
      // model (see modmixer:conversations:set-model), so this never touches a
      // live session.
      return saveSettings({ model: selection });
    },
  );

  ipc.handle(
    'modmixer:settings:set-default-author',
    (_evt, defaultAuthor: string) => saveSettings({ defaultAuthor }),
  );

  ipc.handle(
    'modmixer:settings:set-analytics-opt-in',
    async (_evt, optIn: boolean) => {
      await setAnalyticsOptIn(optIn);
      return loadSettings();
    },
  );

  ipc.handle(
    'modmixer:settings:set-theme',
    (_evt, theme: ThemePreference) => saveSettings({ theme }),
  );

  ipc.handle(
    'modmixer:settings:set-thinking-level',
    (_evt, level: ThinkingLevel) => {
      // Default reasoning effort for NEW chats only; existing chats keep
      // their own (see modmixer:conversations:set-thinking-level).
      return saveSettings({ thinkingLevel: level });
    },
  );

  ipc.handle(
    'modmixer:settings:set-multi-chat',
    (_evt, enabled: boolean) => saveSettings({ multiChat: enabled }),
  );

  ipc.handle(
    'modmixer:settings:set-community-lore',
    async (_evt, enabled: boolean) => {
      const before = loadSettings().useCommunityLore;
      const next = saveSettings({ useCommunityLore: enabled });
      if (enabled && !before) {
        // First activation: seed the cache from the shipped bundle so the
        // agent has something to read before the first network pull lands.
        try {
          await seedCommunityLoreFromShipped();
        } catch (err) {
          console.error('[community-lore] seed failed:', err);
        }
        // Fire the first push/pull immediately so the user sees the latest
        // curated entries without waiting for the next launch.
        void syncCommunityLore();
      } else if (!enabled && before) {
        // Toggle going off — wipe the cache so the read path reverts to the
        // shipped bundle with no stale crowd-sourced residue.
        try {
          await clearCommunityLore();
        } catch (err) {
          console.error('[community-lore] clear failed:', err);
        }
      }
      return next;
    },
  );

  ipc.handle('modmixer:models:list', () => host.listAvailableModels());

  ipc.handle('modmixer:oauth:list', () => host.listOAuthLinks());

  ipc.handle('modmixer:oauth:login', (_evt, providerId: string) => {
    // Fire-and-forget: the long-running login emits its own state events. We
    // resolve the IPC immediately so the renderer never blocks on it.
    void host.loginOAuth(providerId);
  });

  ipc.handle('modmixer:oauth:cancel-login', () => {
    host.cancelOAuthLogin();
  });

  ipc.handle(
    'modmixer:oauth:provide-code',
    (_evt, providerId: string, value: string) => {
      host.provideOAuthCode(providerId, value);
    },
  );

  ipc.handle('modmixer:oauth:logout', async (_evt, providerId: string) => {
    await host.logoutOAuth(providerId);
  });

  // OpenRouter — BYO key + free-text slug list. Lives outside the OAuth flow
  // because OpenRouter is API-key-only and we don't curate models.
  ipc.handle('modmixer:openrouter:get-config', () => host.getOpenRouterConfig());

  ipc.handle('modmixer:openrouter:set-api-key', async (_evt, key: string | null) =>
    host.setOpenRouterApiKey(key),
  );

  ipc.handle('modmixer:openrouter:add-model', async (_evt, slug: string) =>
    host.addOpenRouterModel(slug),
  );

  ipc.handle('modmixer:openrouter:remove-model', async (_evt, slug: string) =>
    host.removeOpenRouterModel(slug),
  );

  ipc.handle('modmixer:openrouter:get-credits', () => host.getOpenRouterCredits());

  // Local OpenAI-compatible providers — BYO base URL + (optional) API key.
  // Same plumbing as OpenRouter, but one provider per server so multiple
  // local stacks (LM Studio + Ollama + …) can coexist.
  ipc.handle('modmixer:local:list', () => host.getLocalProviders());

  ipc.handle(
    'modmixer:local:add',
    async (
      _evt,
      input: { label: string; baseUrl: string; apiKey?: string | null },
    ) => host.addLocalProvider(input),
  );

  ipc.handle(
    'modmixer:local:update',
    async (
      _evt,
      id: string,
      patch: { label?: string; baseUrl?: string; apiKey?: string | null },
    ) => host.updateLocalProvider(id, patch),
  );

  ipc.handle('modmixer:local:remove', async (_evt, id: string) =>
    host.removeLocalProvider(id),
  );

  ipc.handle(
    'modmixer:local:add-model',
    async (_evt, id: string, modelId: string) => host.addLocalModel(id, modelId),
  );

  ipc.handle(
    'modmixer:local:remove-model',
    async (_evt, id: string, modelId: string) =>
      host.removeLocalModel(id, modelId),
  );

  ipc.handle('modmixer:local:discover', async (_evt, baseUrl: string) =>
    host.discoverLocalModels(baseUrl),
  );
}
