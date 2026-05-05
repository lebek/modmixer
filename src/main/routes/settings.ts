import {
  loadSettings,
  saveSettings,
  type ModelSelection,
  type ThemePreference,
} from '../../agent/settings.js';
import { setAnalyticsOptIn } from '../../agent/telemetry.js';
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
    async (_evt, selection: ModelSelection) => {
      const next = saveSettings({ model: selection });
      await host.setModel(selection);
      return next;
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
}
