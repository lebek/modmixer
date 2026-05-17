import { app } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ThinkingLevel } from '@mariozechner/pi-agent-core';
import { sanitizeAuthorHandle } from '../lib/identifiers.js';

export interface ModelSelection {
  provider: string;
  modelId: string;
}

/**
 * A user-configured local OpenAI-compatible server. Registered with pi-ai as
 * provider `local:<id>` so it slots into the same modelRegistry plumbing as
 * the built-in OAuth providers and OpenRouter.
 */
export interface LocalProvider {
  /** Stable id, minted on creation. Used as the suffix of the pi provider name. */
  id: string;
  /** User-supplied display name surfaced in the model picker ("LM Studio"). */
  label: string;
  /** OpenAI-compatible endpoint, e.g. `http://localhost:1234/v1`. */
  baseUrl: string;
  /** Model ids the user has added (and chosen to surface in the picker). */
  models: string[];
}

export type ThemePreference = 'dark' | 'light' | 'auto';

export const THINKING_LEVELS: ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    typeof value === 'string' &&
    (THINKING_LEVELS as readonly string[]).includes(value)
  );
}

export interface Consent {
  /** Consent version the user accepted. Matches CURRENT_CONSENT_VERSION at acceptance time. */
  version: string;
  /** ISO-8601 timestamp of acceptance. */
  acceptedAt: string;
}

export interface OnboardingState {
  /** Onboarding version the user completed. Matches CURRENT_ONBOARDING_VERSION at completion time. */
  version: string;
  /** ISO-8601 timestamp of completion. */
  completedAt: string;
}

/**
 * The consent version the current build of modmixer enforces. Bump this
 * when the consent screen materially changes — users will be re-prompted
 * on next launch.
 */
export const CURRENT_CONSENT_VERSION = '1.0';

/**
 * The onboarding version the current build of modmixer enforces. Bump this
 * when a step is added or materially changed and existing users should walk
 * through the flow again (e.g. a new required dependency).
 */
export const CURRENT_ONBOARDING_VERSION = '1.0';

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
  /**
   * Onboarding completion record. Absent until the user clicks through the
   * first-run flow. The renderer gates the main UI until this is set with a
   * version matching CURRENT_ONBOARDING_VERSION.
   */
  onboarding: OnboardingState | null;
  /**
   * User-supplied path to RimWorld's install directory (the folder containing
   * RimWorldWin64_Data/, RimWorldMac.app/, or RimWorldLinux_Data/). Set when
   * the auto-detector misses Steam's install — e.g. a non-standard library
   * location. detectRimWorldPaths() consults this before falling back to the
   * hard-coded candidate list.
   */
  rimworldInstallOverride: string | null;
  /**
   * OpenRouter model slugs the user has saved (e.g. "anthropic/claude-sonnet-4.5",
   * "qwen/qwen3-coder"). Surfaces these in the model picker as additional
   * options when an OpenRouter API key is stored. The API key itself lives
   * in AuthStorage (encrypted), not here.
   */
  openrouterModels: string[];
  /**
   * User-configured local OpenAI-compatible servers (LM Studio, Ollama,
   * llama.cpp, vLLM, …). Each entry produces one provider in the model
   * picker. API keys live in AuthStorage under `local:<id>` so they're
   * encrypted at rest — most local servers don't need one, but some proxies
   * do.
   */
  localProviders: LocalProvider[];
  /**
   * User's preferred reasoning level. Surfaced as a dropdown next to the
   * model picker. Pi clamps this against the active model's capabilities
   * (e.g. "xhigh" → "high" on anything that's not Opus 4.7), so the value
   * here is the user's intent — not necessarily what the next turn will use.
   */
  thinkingLevel: ThinkingLevel;
  /**
   * Advanced opt-in: lets a mod keep multiple chats that the user can switch
   * between (and run concurrently). Off by default — with it off the UI shows
   * a single active chat per mod exactly as before, and "+ New chat" archives
   * the current one.
   */
  multiChat: boolean;
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
    onboarding: null,
    rimworldInstallOverride: null,
    openrouterModels: [],
    localProviders: [],
    thinkingLevel: 'xhigh',
    multiChat: false,
  };
}

type FieldReader<T> = (raw: unknown) => T | undefined;

const readString: FieldReader<string> = (v) =>
  typeof v === 'string' && v.length > 0 ? v : undefined;
const readBool: FieldReader<boolean> = (v) =>
  typeof v === 'boolean' ? v : undefined;

function readObjectShape<T>(
  raw: unknown,
  required: { [K in keyof T]: FieldReader<T[K]> },
): T | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const out = {} as T;
  for (const key of Object.keys(required) as (keyof T)[]) {
    const value = required[key](obj[key as string]);
    if (value === undefined) return undefined;
    out[key] = value;
  }
  return out;
}

function normalize(raw: unknown, defaults: Settings): Settings {
  if (!raw || typeof raw !== 'object') return { ...defaults };
  const obj = raw as Record<string, unknown>;
  const next: Settings = { ...defaults };

  const defaultAuthor = readString(obj.defaultAuthor);
  if (defaultAuthor !== undefined) {
    next.defaultAuthor = sanitizeAuthorHandle(defaultAuthor) || defaults.defaultAuthor;
  }

  const distinctId = readString(obj.distinctId);
  if (distinctId !== undefined) next.distinctId = distinctId;

  const analyticsOptIn = readBool(obj.analyticsOptIn);
  if (analyticsOptIn !== undefined) next.analyticsOptIn = analyticsOptIn;

  if (obj.theme === 'dark' || obj.theme === 'light' || obj.theme === 'auto') {
    next.theme = obj.theme;
  }

  const consent = readObjectShape<Consent>(obj.consent, {
    version: readString,
    acceptedAt: readString,
  });
  if (consent) next.consent = consent;

  const onboarding = readObjectShape<OnboardingState>(obj.onboarding, {
    version: readString,
    completedAt: readString,
  });
  if (onboarding) next.onboarding = onboarding;

  const rimworldInstallOverride = readString(obj.rimworldInstallOverride);
  if (rimworldInstallOverride !== undefined) {
    next.rimworldInstallOverride = rimworldInstallOverride;
  }

  if (Array.isArray(obj.openrouterModels)) {
    next.openrouterModels = obj.openrouterModels.filter(
      (s): s is string => typeof s === 'string' && s.length > 0,
    );
  }

  if (Array.isArray(obj.localProviders)) {
    next.localProviders = obj.localProviders.flatMap((raw): LocalProvider[] => {
      if (!raw || typeof raw !== 'object') return [];
      const r = raw as Record<string, unknown>;
      const id = readString(r.id);
      const label = readString(r.label);
      const baseUrl = readString(r.baseUrl);
      if (!id || !label || !baseUrl) return [];
      const models = Array.isArray(r.models)
        ? r.models.filter((m): m is string => typeof m === 'string' && m.length > 0)
        : [];
      return [{ id, label, baseUrl, models }];
    });
  }

  if (isThinkingLevel(obj.thinkingLevel)) {
    next.thinkingLevel = obj.thinkingLevel;
  }

  const multiChat = readBool(obj.multiChat);
  if (multiChat !== undefined) next.multiChat = multiChat;

  const model = readObjectShape<ModelSelection>(obj.model, {
    provider: readString,
    modelId: readString,
  });
  if (model) next.model = model;

  // Legacy { modelId: string } shape from the pre-OAuth build is intentionally
  // not migrated — the rejig replaces the model picker entirely.
  return next;
}

export function loadSettings(): Settings {
  if (cached) return cached;
  const defaults = computeDefaults();
  let raw: unknown = null;
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    // file missing, unreadable, or unparseable — fall through to defaults.
  }
  const next = raw ? normalize(raw, defaults) : { ...defaults };
  cached = next;
  // posthog-node has no client-side persistence, so we mint and persist the
  // distinctId ourselves. Pre-telemetry settings.json files won't have one;
  // persist the freshly-minted id so the same id sticks across restarts and
  // every launch doesn't look like a new user.
  const hadDistinctId =
    raw !== null &&
    typeof (raw as Record<string, unknown>).distinctId === 'string';
  if (!hadDistinctId) {
    try {
      const file = settingsPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(next, null, 2));
    } catch {
      // Persistence failures shouldn't block startup; the id will be
      // re-minted next launch (counts as a new user, which is strictly
      // better than crashing).
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

/**
 * True when the user has completed the onboarding flow at the version this
 * build enforces. Used to gate the main UI on first launch (and after a
 * version bump).
 */
export function hasCompletedOnboarding(
  settings: Settings = loadSettings(),
): boolean {
  if (process.env.MODMIXER_FORCE_ONBOARDING === '1') return false;
  return settings.onboarding?.version === CURRENT_ONBOARDING_VERSION;
}

export function recordOnboardingComplete(version: string): Settings {
  return saveSettings({
    onboarding: {
      version,
      completedAt: new Date().toISOString(),
    },
  });
}

/**
 * Wipe the onboarding (and optionally consent) record so the gate runs
 * again. Used by the dev `--reset-onboarding` CLI flag and the "Re-run
 * onboarding" button in Settings → General.
 */
export function resetOnboarding(options: { alsoConsent?: boolean } = {}): Settings {
  const patch: Partial<Settings> = { onboarding: null };
  if (options.alsoConsent) patch.consent = null;
  return saveSettings(patch);
}
