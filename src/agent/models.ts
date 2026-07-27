export interface ModelOption {
  /** Stable composite id, "<provider>/<modelId>", used by the picker. */
  key: string;
  provider: string;
  /** Human-friendly provider label ("Claude", "ChatGPT", …). */
  providerLabel: string;
  /** Model id as known to pi-ai (e.g. "claude-sonnet-4-5-20250929"). */
  modelId: string;
  /** Short label for the dropdown row ("Sonnet 4.5"). */
  label: string;
  /** Surfaced as a "★ Recommended —" prefix in the picker; sorted first. */
  recommended?: boolean;
  /**
   * Whether the model accepts image input. `false` means chat image
   * attachments can't be shown to it; `undefined` means we couldn't
   * determine it (e.g. a local server that doesn't report modalities) — the
   * UI treats undefined as "don't warn" to avoid false alarms.
   */
  vision?: boolean;
}
