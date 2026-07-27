/**
 * Which models from pi's catalog we put in front of the user.
 *
 * Kept apart from agent-host so it stays pure (no Electron, no pi runtime) —
 * these are the rules that used to be a hand-maintained list of model ids,
 * so they're worth testing directly. See `__tests__/model-selection.test.ts`.
 */
import type { Api, Model } from '@earendil-works/pi-ai';

/**
 * Hosted providers whose models we surface in the picker, in display order.
 *
 * This is a provider-integration list, not a model list: each entry is a
 * login flow we've actually wired up and tested. Which *models* appear under
 * a provider is derived from pi's catalog at runtime (see `featuredModels`),
 * so a new flagship shows up without an app release — pi refreshes its
 * catalog from pi.dev in the background.
 *
 * OpenRouter and local servers are deliberately absent: both are BYO-endpoint
 * flows with their own settings UI and their own picker rows.
 */
export const HOSTED_PROVIDERS = ['anthropic', 'openai-codex', 'github-copilot'];

/**
 * Model ids that are never useful in modmixer regardless of provider —
 * non-chat modalities and specialist endpoints that would otherwise survive
 * the newest-per-family filter below. Matched against the full id.
 */
const EXCLUDED_MODEL_PATTERNS = [
  /-image$/,
  /-live(-|$)/,
  /computer-use/,
  /robotics/,
  /^deep-research/,
  /embed/,
];

/**
 * Dated aliases (`claude-haiku-4-5-20251001`) duplicate the rolling id
 * (`claude-haiku-4-5`) that we already show. Drop them so the picker lists
 * each model once.
 */
const DATED_ALIAS = /-\d{8}$/;

/** First version token in an id: `4-8` in `claude-opus-4-8`, `5.6` in `gpt-5.6-sol`. */
const VERSION_TOKEN = /\d+(?:[.-]\d+)*/;

/**
 * Split an id into a family key and a comparable version. The family is the
 * id with its version token blanked out, so `claude-opus-4-8`, `claude-opus-5`
 * and `claude-opus-4.7` all collapse to `claude-opus-*` while
 * `claude-sonnet-*`, `gpt-*-mini` and `gpt-*-terra` stay distinct.
 *
 * Ids with no version token are their own family at version 0 — they're kept
 * as-is rather than being silently grouped together.
 */
export function modelFamily(id: string): { family: string; version: number[] } {
  const match = VERSION_TOKEN.exec(id);
  if (!match) return { family: id, version: [0] };
  return {
    family: id.replace(match[0], '*'),
    version: match[0].split(/[.-]/).map((part) => Number(part)),
  };
}

/** Lexicographic compare of dotted version parts: 5 > 4.8, 5.6 > 5.5. */
function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Leading segment of an id — `claude`, `gemini`, `gpt`, `kimi`. Used only for
 * grouping: version numbers are comparable within a brand and meaningless
 * across them (Gemini 3.5 is not "older" than GPT 5.4).
 */
function modelBrand(id: string): string {
  return id.split('-')[0] ?? id;
}

/**
 * The models we surface for one provider: the newest member of each family.
 *
 * pi's catalog carries every model a provider has ever shipped — Anthropic
 * alone lists Opus 4.1 through Opus 5, and GitHub Copilot resells four
 * vendors' line-ups — and a picker that long buries the one the user wants.
 * Rather than a hand-maintained whitelist (which is what forced an app
 * release for every new flagship), keep the highest version within each
 * family: Opus 5 hides Opus 4.8, Sonnet 5 hides Sonnet 4.6, and a model with
 * no successor (Haiku 4.5, Fable 5) stays visible on its own.
 *
 * Ordering groups a brand's models together, newest first within the brand,
 * so a multi-vendor provider reads as a few short blocks instead of one list
 * shuffled by unrelated version numbers.
 */
export function featuredModels(models: readonly Model<Api>[]): Model<Api>[] {
  const best = new Map<string, { model: Model<Api>; version: number[] }>();
  for (const model of models) {
    if (DATED_ALIAS.test(model.id)) continue;
    if (EXCLUDED_MODEL_PATTERNS.some((re) => re.test(model.id))) continue;
    const { family, version } = modelFamily(model.id);
    const current = best.get(family);
    if (!current || compareVersions(version, current.version) > 0) {
      best.set(family, { model, version });
    }
  }
  return [...best.values()]
    .sort(
      (a, b) =>
        modelBrand(a.model.id).localeCompare(modelBrand(b.model.id)) ||
        compareVersions(b.version, a.version) ||
        a.model.id.localeCompare(b.model.id),
    )
    .map((entry) => entry.model);
}

/**
 * Per-provider default, as a family key (`claude-sonnet-*`) or an exact id:
 * a Sonnet-tier model — capable enough for real mod work, cheap enough to
 * leave running. Picked when the user hasn't chosen one yet, so we don't
 * strand them on the cheapest or burn through Opus usage by accident.
 *
 * Family keys track the catalog: when Sonnet 6 lands, `claude-sonnet-*`
 * resolves to it with no code change. OpenRouter is pinned to an exact slug
 * because its "catalog" is the user's own saved list.
 */
export const DEFAULT_MODEL: Record<string, string> = {
  anthropic: 'claude-sonnet-*',
  'openai-codex': 'gpt-*-terra',
  'github-copilot': 'claude-sonnet-*',
  openrouter: 'moonshotai/kimi-k2.6',
};

/**
 * Resolve a `DEFAULT_MODEL` entry against the provider's live catalog.
 * Exact ids win over family keys so a pinned slug always means itself.
 */
export function resolveDefaultModel(
  provider: string,
  models: readonly Model<Api>[],
): Model<Api> | null {
  const key = DEFAULT_MODEL[provider];
  if (!key) return null;
  const candidates = featuredModels(
    models.filter((m) => m.provider === provider),
  );
  return (
    candidates.find((m) => m.id === key) ??
    candidates.find((m) => modelFamily(m.id).family === key) ??
    null
  );
}
