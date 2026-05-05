import type { PublishProgressEvent, PublishStatus } from '@/agent/workshop';

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <header>
        <h2 className="font-display text-sm font-medium text-ink">{title}</h2>
        {description && (
          <p className="mt-0.5 text-xs text-muted">{description}</p>
        )}
      </header>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  action,
  children,
}: {
  label: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <label className="text-[10px] uppercase tracking-[0.18em] text-muted">
          {label}
        </label>
        {action}
      </div>
      {children}
      {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function ErrorBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-failed/40 bg-failed/5 px-3 py-2 text-xs text-failed">
      {children}
    </div>
  );
}

export function PublishProgress({ progress }: { progress: PublishProgressEvent }) {
  const pct =
    progress.total && progress.uploaded !== undefined && progress.total > 0
      ? Math.min(100, Math.round((progress.uploaded / progress.total) * 100))
      : null;
  return (
    <div className="rounded-md border border-line bg-surface/60 px-3 py-2 text-xs text-ink">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
          {labelForStatus(progress.status)}
        </span>
        {pct !== null && (
          <span className="font-mono text-[10px] text-muted">{pct}%</span>
        )}
      </div>
      {pct !== null && (
        <div className="mt-1 h-1 w-full overflow-hidden rounded bg-line/60">
          <div
            className="h-full bg-accent transition-[width] duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function labelForStatus(status: PublishStatus): string {
  switch (status) {
    case 'preparing': return 'Preparing';
    case 'creating-item': return 'Creating Workshop item';
    case 'agreement-required': return 'Awaiting agreement';
    case 'uploading-content': return 'Uploading content';
    case 'uploading-preview': return 'Uploading preview';
    case 'committing': return 'Committing';
    case 'done': return 'Done';
    case 'error': return 'Error';
  }
}
