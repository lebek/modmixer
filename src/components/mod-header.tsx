import type { WorkspaceMod } from '../agent/workspace';
import { cn } from '@/lib/cn';

export function ModHeader({
  mod,
  busy,
  onTest,
  hasAi,
}: {
  mod: WorkspaceMod;
  busy: boolean;
  onTest: () => void;
  hasAi: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-b border-line px-5 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <h1 className="truncate font-display text-base font-medium text-ink">
            {mod.about.name || mod.folder}
          </h1>
          {mod.about.packageId && (
            <span className="truncate font-mono text-[10px] uppercase tracking-[0.18em] text-subtle">
              {mod.about.packageId}
            </span>
          )}
        </div>
        {(mod.schematic?.shortDescription || mod.about.description) && (
          <p className="mt-0.5 truncate text-xs text-muted">
            {mod.schematic?.shortDescription || mod.about.description}
          </p>
        )}
      </div>
      <div className="ml-4 flex items-center gap-2">
        <StatusPill active={mod.active} />
        <button
          onClick={onTest}
          disabled={busy || !hasAi}
          title={!hasAi ? 'Connect an AI provider to run tests' : undefined}
          className={cn(
            'group inline-flex items-center gap-2 rounded-md border border-accent bg-accent px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-foreground shadow-sm transition-all hover:bg-accent-soft hover:shadow-md active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none',
          )}
        >
          <LaunchIcon />
          launch
        </button>
      </div>
    </div>
  );
}

function LaunchIcon() {
  return (
    <svg
      aria-hidden
      className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 group-active:translate-x-0"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function StatusPill({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em]',
        active
          ? 'border-ready/40 bg-ready/10 text-ready'
          : 'border-line bg-surface text-muted',
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          active ? 'bg-ready' : 'bg-pending',
        )}
      />
      {active ? 'enabled' : 'disabled'}
    </span>
  );
}
