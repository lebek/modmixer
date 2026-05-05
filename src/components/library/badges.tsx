import { cn } from '@/lib/cn';
import type { ModIssue, RegistryMod } from '@/agent/registry';

export const CORE_PACKAGE_ID = 'ludeon.rimworld';

export function shortIssue(kind: ModIssue['kind']): string {
  switch (kind) {
    case 'missing-dependency':
      return 'missing dep';
    case 'incompatible-mod-active':
      return 'incompat';
    case 'load-order-violation':
      return 'order';
    case 'version-incompat':
      return 'version';
  }
}

export function SourceBadge({
  source,
  isCore,
}: {
  source: RegistryMod['source'];
  isCore?: boolean;
}) {
  const label = isCore
    ? 'Core'
    : source === 'official'
    ? 'DLC'
    : source === 'workshop'
    ? 'Workshop'
    : source === 'workspace'
    ? 'Modmixer'
    : 'Local';
  const cls = isCore
    ? 'bg-amber-500/15 text-amber-700 border-amber-500/30'
    : source === 'official'
    ? 'bg-violet-500/15 text-violet-700 border-violet-500/30'
    : source === 'workshop'
    ? 'bg-sky-500/15 text-sky-700 border-sky-500/30'
    : source === 'workspace'
    ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/30'
    : 'bg-stone-500/15 text-stone-700 border-stone-500/30';
  return (
    <span
      className={cn(
        'rounded border px-1 py-0.5 font-mono text-[9px] uppercase tracking-wide',
        cls,
      )}
    >
      {label}
    </span>
  );
}

export function Badge({
  children,
  tone,
  title,
}: {
  children: React.ReactNode;
  tone: 'neutral' | 'warn' | 'error';
  title?: string;
}) {
  const cls =
    tone === 'warn'
      ? 'bg-amber-500/15 text-amber-700 border-amber-500/30'
      : tone === 'error'
      ? 'bg-red-500/15 text-red-700 border-red-500/30'
      : 'bg-stone-500/10 text-muted border-line';
  return (
    <span
      title={title}
      className={cn(
        'rounded border px-1 py-0.5 font-mono text-[9px] uppercase tracking-wide',
        cls,
      )}
    >
      {children}
    </span>
  );
}

export function IconButton({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="rounded-md border border-line px-1.5 text-xs text-muted hover:border-ink/40 hover:text-ink disabled:opacity-50"
    >
      {children}
    </button>
  );
}
