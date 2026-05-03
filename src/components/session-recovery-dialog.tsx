import type { ActiveSession } from '../agent/registry';

export function SessionRecoveryDialog({
  session,
  onApply,
  onRevert,
  onDismiss,
}: {
  session: ActiveSession;
  onApply: () => Promise<void>;
  onRevert: () => Promise<void>;
  onDismiss: () => void;
}) {
  const label =
    session.type === 'test'
      ? `a test session for "${session.testTarget?.folder ?? 'a workspace mod'}"`
      : 'a fix session';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div className="w-full max-w-md rounded-lg border border-line bg-paper p-6 shadow-xl">
        <h2 className="font-display text-lg font-medium text-ink">
          Recover unfinished session?
        </h2>
        <p className="mt-2 text-sm text-muted">
          Modmixer was in the middle of {label}, started{' '}
          {new Date(session.startedAt).toLocaleString()}.
        </p>
        <p className="mt-2 text-sm text-muted">
          We snapshotted your original ModsConfig.xml — apply makes the current
          state permanent, revert restores your original mod list. Either way
          the snapshot is then cleaned up.
        </p>
        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            onClick={onDismiss}
            className="rounded-md border border-line px-3 py-1.5 text-xs text-muted hover:border-ink/40 hover:text-ink"
          >
            Decide later
          </button>
          <button
            onClick={() => void onRevert()}
            className="rounded-md border border-amber-500/40 bg-paper px-3 py-1.5 text-xs uppercase tracking-wide text-amber-900 hover:bg-amber-500/10"
          >
            Revert to original
          </button>
          <button
            onClick={() => void onApply()}
            className="rounded-md bg-amber-500 px-3 py-1.5 text-xs uppercase tracking-wide text-paper hover:bg-amber-600"
          >
            Apply current
          </button>
        </div>
      </div>
    </div>
  );
}
