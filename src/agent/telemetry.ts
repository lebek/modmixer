import { app } from 'electron';
import { PostHog } from 'posthog-node';
import { loadSettings, saveSettings } from './settings.js';

/**
 * Product-analytics events. Three, intentionally:
 *   - app_started   → usage / retention / version health
 *   - mod_created   → activation
 *   - mod_published → value delivered
 *
 * Don't add a fourth without a specific question it answers. Properties
 * are typed so call sites can't drift.
 */
export type TelemetryEvent =
  | { name: 'app_started'; props?: Record<string, never> }
  | { name: 'mod_created'; props?: Record<string, never> }
  | { name: 'mod_published'; props?: Record<string, never> };

/**
 * Configured at build time via Vite's `define`. Empty string = analytics
 * disabled at the binary level (e.g. local dev builds without env keys).
 */
declare const __POSTHOG_KEY__: string;
declare const __POSTHOG_HOST__: string;

let client: PostHog | null = null;

const POSTHOG_KEY: string =
  typeof __POSTHOG_KEY__ === 'string' ? __POSTHOG_KEY__ : '';
const POSTHOG_HOST: string =
  typeof __POSTHOG_HOST__ === 'string' && __POSTHOG_HOST__
    ? __POSTHOG_HOST__
    : 'https://us.i.posthog.com';

/**
 * Initialize the PostHog client if the user has opted in and a build-time
 * key is present. Idempotent — call from app startup and from the opt-in
 * toggle when the user flips it on at runtime.
 *
 * Sets app version and OS once as person properties (`$set`) so events
 * stay clean. We deliberately don't attach version/platform per-event —
 * it looks like fingerprinting and isn't useful at that granularity.
 */
export function initTelemetry(): void {
  if (client) return;
  if (!POSTHOG_KEY) return;
  const { analyticsOptIn, distinctId } = loadSettings();
  if (!analyticsOptIn) return;

  client = new PostHog(POSTHOG_KEY, {
    host: POSTHOG_HOST,
    flushAt: 20,
    flushInterval: 10_000,
  });

  client.identify({
    distinctId,
    properties: {
      $set: {
        app_version: app.getVersion(),
        platform: process.platform,
      },
    },
  });
}

/**
 * Fire an event. No-ops cleanly when the user hasn't opted in or the
 * client failed to init — call sites don't need to guard.
 */
export function track(event: TelemetryEvent): void {
  if (!client) return;
  const { distinctId } = loadSettings();
  client.capture({
    distinctId,
    event: event.name,
    properties: event.props ?? {},
    disableGeoip: true,
  });
}

/**
 * Toggle analytics on/off at runtime. When turning on, also fires
 * `app_started` so the user shows up in the active-users metric without
 * needing to relaunch.
 */
export async function setAnalyticsOptIn(optIn: boolean): Promise<void> {
  const before = loadSettings().analyticsOptIn;
  saveSettings({ analyticsOptIn: optIn });
  if (optIn && !before) {
    initTelemetry();
    track({ name: 'app_started' });
  } else if (!optIn && before) {
    await shutdownTelemetry();
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (client) {
    const c = client;
    client = null;
    try {
      await c.shutdown();
    } catch {
      // Network failure on shutdown is fine — events flushed best-effort.
    }
  }
}
