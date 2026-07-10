import {
  LEVEL_LABELS,
  THINKING_LEVELS,
  type MixerThinkingLevel as ThinkingLevel,
} from '../lib/thinking-levels';

export function ThinkingPicker({
  current,
  onChange,
}: {
  current: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
}) {
  return (
    <label className="relative inline-flex items-center" title="Thinking effort">
      <span className="sr-only">Thinking</span>
      <select
        value={current}
        onChange={(e) => onChange(e.target.value as ThinkingLevel)}
        className="appearance-none rounded-md border border-line bg-paper px-2.5 py-1 pr-7 font-mono text-[11px] uppercase tracking-[0.18em] text-ink transition-colors hover:border-ink/40 focus:outline-none focus:border-accent"
      >
        {THINKING_LEVELS.map((level) => (
          <option key={level} value={level} className="font-mono">
            Think: {LEVEL_LABELS[level]}
          </option>
        ))}
      </select>
      <svg
        aria-hidden
        className="pointer-events-none absolute right-2 h-3 w-3 text-muted"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M3 5l3 3 3-3" />
      </svg>
    </label>
  );
}
