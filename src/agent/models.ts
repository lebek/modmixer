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
  /**
   * Rough cost band: '$' = cheap/fast, '$$' = mid, '$$$' = flagship. Omitted
   * for user-supplied entries (e.g. OpenRouter slugs) where we don't curate
   * pricing.
   */
  costTier?: '$' | '$$' | '$$$';
  /** Surfaced as a "★ Recommended —" prefix in the picker; sorted first. */
  recommended?: boolean;
}
