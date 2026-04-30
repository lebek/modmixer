import type { ModelOption } from '../agent/models';
import type { ModelSelection } from '../agent/settings';

export function ModelPicker({
  models,
  current,
  onChange,
  onConnect,
}: {
  models: ModelOption[];
  current: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
  onConnect: () => void;
}) {
  if (models.length === 0) {
    return (
      <button
        onClick={onConnect}
        className="rounded-md border border-line bg-paper px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/40 hover:text-ink"
      >
        Connect AI
      </button>
    );
  }

  const currentKey = current ? `${current.provider}/${current.modelId}` : '';
  // If the saved selection isn't in the available list (e.g., the user just
  // logged out the provider it pointed at), implicitly fall back to the first
  // available model so the dropdown reflects what the agent will actually use.
  const effectiveKey =
    models.find((m) => m.key === currentKey)?.key ?? models[0].key;

  const onSelect = (key: string) => {
    const m = models.find((x) => x.key === key);
    if (m) onChange({ provider: m.provider, modelId: m.modelId });
  };

  return (
    <label className="relative inline-flex items-center">
      <span className="sr-only">Model</span>
      <select
        value={effectiveKey}
        onChange={(e) => onSelect(e.target.value)}
        className="appearance-none rounded-md border border-line bg-paper px-2.5 py-1 pr-7 font-mono text-[11px] uppercase tracking-[0.18em] text-ink transition-colors hover:border-ink/40 focus:outline-none focus:border-accent"
      >
        {models.map((m) => (
          <option key={m.key} value={m.key} className="font-mono">
            {m.providerLabel} — {m.label} {m.costTier}
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
