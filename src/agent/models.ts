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
  /** Rough cost band: '$' = cheap/fast, '$$' = mid, '$$$' = flagship. */
  costTier: '$' | '$$' | '$$$';
}
