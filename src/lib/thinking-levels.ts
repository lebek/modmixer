import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';

/**
 * Modmixer's thinking scale: pi's levels plus a `max` rung on top.
 *
 * pi 0.80.x tops out at `xhigh`; there is no sixth level upstream. Rather
 * than patching pi's dist (as the pre-0.80 patch set did), `max` lives
 * entirely on the modmixer side of the boundary — settings, conversations,
 * and the picker store it — and `toPiThinking` lowers it onto pi as `xhigh`
 * on a model instance whose thinkingLevelMap sends Anthropic's `max`
 * adaptive effort. Renderer-safe: type-only pi imports, no electron.
 */
export type MixerThinkingLevel = ThinkingLevel | 'max';

export const THINKING_LEVELS: MixerThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export const LEVEL_LABELS: Record<MixerThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};

export function isThinkingLevel(v: unknown): v is MixerThinkingLevel {
  return (
    typeof v === 'string' && THINKING_LEVELS.includes(v as MixerThinkingLevel)
  );
}

/**
 * Whether `max` means anything for this model: adaptive-thinking Anthropic
 * models (Opus 4.6+, Sonnet 4.6+, Fable 5) accept an `effort` value of
 * "max" above "xhigh". Everything else clamps `max` to its own ceiling,
 * exactly like the old patched clampReasoning did.
 */
export function supportsMaxEffort(model: Model<Api>): boolean {
  if (model.api !== 'anthropic-messages') return false;
  const compat = (model as Model<'anthropic-messages'>).compat;
  return compat?.forceAdaptiveThinking === true;
}

/**
 * Lower a modmixer thinking level onto pi's scale at the session boundary.
 *
 * For `max` on an adaptive Anthropic model, pi is handed a copy of the model
 * whose thinkingLevelMap maps xhigh → "max" (plain model metadata — pi's
 * anthropic layer passes the mapped string through as the adaptive effort),
 * and the level `xhigh`. For `max` on anything else, plain `xhigh`. Every
 * other level passes through untouched, so `xhigh` keeps sending "xhigh".
 *
 * Always derive from the pristine registry model, never from a previously
 * returned one, or a later xhigh selection would keep the max-effort map.
 */
export function toPiThinking<TApi extends Api>(
  model: Model<TApi> | undefined,
  level: MixerThinkingLevel,
): { model: Model<TApi> | undefined; level: ThinkingLevel } {
  if (level !== 'max') return { model, level };
  if (!model || !supportsMaxEffort(model)) return { model, level: 'xhigh' };
  return {
    model: {
      ...model,
      thinkingLevelMap: { ...model.thinkingLevelMap, xhigh: 'max' },
    },
    level: 'xhigh',
  };
}
