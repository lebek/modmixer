import type { ActiveSession } from '@/agent/registry';

export function SessionBanner({
  session,
  onApply,
  onRevert,
}: {
  session: ActiveSession;
  onApply: () => void;
  onRevert: () => void;
}) {
  const label =
    session.type === 'test'
      ? `Testing ${session.testTarget?.folder ?? 'mod'} in isolation`
      : 'Fix session in progress';
  return (
    <div className="flex items-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-5 py-2 text-sm">
      <span
        className="h-2 w-2 rounded-full bg-amber-500 animate-pulse"
        aria-hidden
      />
      <span className="font-medium text-amber-900">{label}</span>
      <span className="text-xs text-amber-900/80">
        Started {new Date(session.startedAt).toLocaleTimeString()}
      </span>
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={onRevert}
          className="rounded-md border border-amber-500/40 bg-paper px-3 py-1 text-[11px] uppercase tracking-wide text-amber-900 hover:bg-amber-500/10"
        >
          Revert
        </button>
        <button
          onClick={onApply}
          className="rounded-md bg-amber-500 px-3 py-1 text-[11px] uppercase tracking-wide text-paper hover:bg-amber-600"
        >
          Apply
        </button>
      </div>
    </div>
  );
}
