import { app, dialog } from 'electron';
import {
  CURRENT_CONSENT_VERSION,
  CURRENT_ONBOARDING_VERSION,
  hasCompletedOnboarding,
  loadSettings,
  recordConsent,
  recordOnboardingComplete,
  resetOnboarding,
  saveSettings,
} from '../../agent/settings.js';
import { setRimWorldInstallOverride } from '../../agent/paths.js';
import { invalidatePathPolicyRoots } from '../../agent/security/policy-roots.js';
import { detectEnv } from '../../agent/env-detect.js';
import { setAnalyticsOptIn } from '../../agent/telemetry.js';
import { getRegistry } from '../../agent/registry/index.js';
import {
  checkForUpdates,
  getUpdaterState,
  quitAndInstall,
} from '../../agent/updater.js';
import { approveQuit } from '../quit-guard.js';
import type { RouteContext } from './context.js';

/**
 * App-level IPC: version, updater, consent gate, onboarding gate, and env
 * detection / RimWorld install picker.
 */
export function registerLifecycleRoutes(ctx: RouteContext): void {
  const { ipc, getWindow } = ctx;

  ipc.handle('modmixer:app:version', () => app.getVersion());

  ipc.handle('modmixer:updater:get-state', () => getUpdaterState());
  ipc.handle('modmixer:updater:check', () => checkForUpdates());
  ipc.handle('modmixer:updater:quit-and-install', () => {
    // Skip the quit-confirm prompt — the user already chose to restart, and
    // the confirm's preventDefault would fight quitAndInstall's app.quit().
    approveQuit();
    quitAndInstall();
  });

  ipc.handle('modmixer:consent:get', () => ({
    required: CURRENT_CONSENT_VERSION,
    accepted: loadSettings().consent,
  }));

  ipc.handle(
    'modmixer:consent:accept',
    async (_evt, options?: { analyticsOptIn?: boolean }) => {
      const next = recordConsent(CURRENT_CONSENT_VERSION);
      await setAnalyticsOptIn(options?.analyticsOptIn !== false);
      return next;
    },
  );

  ipc.handle('modmixer:onboarding:get-status', () => ({
    required: CURRENT_ONBOARDING_VERSION,
    completed: loadSettings().onboarding,
    /** True when the renderer should show the onboarding flow on this launch. */
    shouldShow: !hasCompletedOnboarding(),
  }));

  ipc.handle('modmixer:onboarding:complete', () =>
    recordOnboardingComplete(CURRENT_ONBOARDING_VERSION),
  );

  ipc.handle('modmixer:onboarding:reset', () => resetOnboarding());

  ipc.handle('modmixer:env:detect', () => detectEnv());

  ipc.handle('modmixer:env:browse-rimworld-install', async () => {
    const win = getWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Pick your RimWorld install folder',
      message:
        'Choose the folder containing RimWorldWin64_Data, RimWorldMac.app, or RimWorldLinux_Data.',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const chosen = result.filePaths[0];
    // Persist + push the override into the path resolver so a follow-up
    // detectEnv() picks it up immediately.
    saveSettings({ rimworldInstallOverride: chosen });
    setRimWorldInstallOverride(chosen);
    invalidatePathPolicyRoots();
    // Refresh the registry so the env snapshot's mod counts reflect the new
    // install. start() is idempotent.
    const registry = getRegistry();
    await registry.start();
    await registry.refresh();
    return chosen;
  });

  ipc.handle('modmixer:env:clear-rimworld-install-override', async () => {
    saveSettings({ rimworldInstallOverride: null });
    setRimWorldInstallOverride(null);
    invalidatePathPolicyRoots();
    await getRegistry().refresh();
    return null;
  });
}
