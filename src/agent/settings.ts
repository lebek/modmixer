import { app } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sanitizeAuthorHandle } from '../lib/identifiers.js';

export interface ModelSelection {
  provider: string;
  modelId: string;
}

export type ThemePreference = 'dark' | 'light' | 'auto';

export interface Consent {
  /** Consent version the user accepted. Matches CURRENT_CONSENT_VERSION at acceptance time. */
  version: string;
  /** ISO-8601 timestamp of acceptance. */
  acceptedAt: string;
}

/**
 * The consent version the current build of modmixer enforces. Bump this
 * when the consent screen materially changes — users will be re-prompted
 * on next launch.
 */
export const CURRENT_CONSENT_VERSION = '1.0';

export interface Settings {
  /**
   * User-selected model. Null means "use the first available model from any
   * linked provider" — handled at resolution time, not persistence time.
   */
  model: ModelSelection | null;
  /** Sluggified author handle used as the prefix in generated packageIds. */
  defaultAuthor: string;
  /**
   * Stable anonymous id for product analytics. Minted on first launch and
   * never tied to user account/email. Used as PostHog distinctId.
   */
  distinctId: string;
  /**
   * Analytics opt-in. On by default — users can flip it off in settings if
   * they don't want to share usage data. The first-run consent screen
   * surfaces this so the on-by-default isn't a surprise.
   */
  analyticsOptIn: boolean;
  /**
   * Consent acceptance record. Absent until the user clicks through the
   * first-run consent screen. The agent is gated until this is set with a
   * version matching CURRENT_CONSENT_VERSION.
   */
  consent: Consent | null;
  /**
   * UI theme preference. "auto" follows the OS setting via
   * prefers-color-scheme. Defaults to "dark".
   */
  theme: ThemePreference;
}

let cached: Settings | null = null;

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function computeDefaults(): Settings {
  return {
    model: null,
    defaultAuthor: sanitizeAuthorHandle(os.userInfo().username),
    distinctId: randomUUID(),
    analyticsOptIn: true,
    consent: null,
    theme: 'dark',
  };
}

function normalize(raw: unknown, defaults: Settings): Settings {
  if (!raw || typeof raw !== 'object') return { ...defaults };
  const obj = raw as Record<string, unknown>;
  const next: Settings = { ...defaults };

  if (typeof obj.defaultAuthor === 'string') {
    next.defaultAuthor = sanitizeAuthorHandle(obj.defaultAuthor) || defaults.defaultAuthor;
  }

  if (typeof obj.distinctId === 'string' && obj.distinctId.length > 0) {
    next.distinctId = obj.distinctId;
  }

  if (typeof obj.analyticsOptIn === 'boolean') {
    next.analyticsOptIn = obj.analyticsOptIn;
  }

  if (
    obj.theme === 'dark' ||
    obj.theme === 'light' ||
    obj.theme === 'auto'
  ) {
    next.theme = obj.theme;
  }

  const c = obj.consent;
  if (
    c &&
    typeof c === 'object' &&
    typeof (c as Record<string, unknown>).version === 'string' &&
    typeof (c as Record<string, unknown>).acceptedAt === 'string'
  ) {
    next.consent = {
      version: (c as Record<string, unknown>).version as string,
      acceptedAt: (c as Record<string, unknown>).acceptedAt as string,
    };
  }

  const m = obj.model;
  if (
    m &&
    typeof m === 'object' &&
    typeof (m as Record<string, unknown>).provider === 'string' &&
    typeof (m as Record<string, unknown>).modelId === 'string'
  ) {
    next.model = {
      provider: (m as Record<string, unknown>).provider as string,
      modelId: (m as Record<string, unknown>).modelId as string,
    };
  }

  // Legacy { modelId: string } shape from the pre-OAuth build is intentionally
  // not migrated — the rejig replaces the model picker entirely.
  return next;
}

export function loadSettings(): Settings {
  if (cached) return cached;
  const defaults = computeDefaults();
  let next: Settings;
  let needsPersist = false;
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    next = normalize(JSON.parse(raw), defaults);
    // First launch on an existing settings.json (pre-telemetry) won't have
    // a distinctId yet — persist the freshly-minted one so the same id sticks
    // across restarts, otherwise every launch would look like a new user.
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.distinctId !== 'string') needsPersist = true;
  } catch {
    next = { ...defaults };
    needsPersist = true;
  }
  cached = next;
  if (needsPersist) {
    try {
      const file = settingsPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(next, null, 2));
    } catch {
      // Persistence failures shouldn't block app startup; the id will be
      // re-minted next launch (analytics will see it as a new user, but
      // that's strictly better than crashing).
    }
  }
  return next;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...loadSettings(), ...patch };
  if (patch.defaultAuthor !== undefined) {
    next.defaultAuthor = sanitizeAuthorHandle(patch.defaultAuthor);
  }
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  cached = next;
  return next;
}

/**
 * True when the user has accepted the consent screen at the version this
 * build enforces. Used to gate the agent and to decide whether the
 * first-run consent screen should be shown.
 */
export function hasCurrentConsent(settings: Settings = loadSettings()): boolean {
  return settings.consent?.version === CURRENT_CONSENT_VERSION;
}

export function recordConsent(version: string): Settings {
  return saveSettings({
    consent: {
      version,
      acceptedAt: new Date().toISOString(),
    },
  });
}
