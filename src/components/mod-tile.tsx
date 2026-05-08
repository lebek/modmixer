import type { WorkspaceMod } from '../agent/workspace';
import { useModPreview } from '@/lib/use-mod-preview';

export function ModTile({
  mod,
  onClick,
}: {
  mod: WorkspaceMod;
  onClick: () => void;
}) {
  const previewUrl = useModPreview(mod.folder);
  const updated = formatRelative(mod.updatedAt);
  const created = formatDate(mod.createdAt);
  return (
    <button
      onClick={onClick}
      className="group flex gap-3 rounded-lg border border-line bg-surface/40 p-4 text-left transition-colors hover:border-ink/30"
    >
      {previewUrl && (
        <div className="aspect-video w-24 shrink-0 overflow-hidden rounded-md border border-line bg-surface/60">
          <img
            src={previewUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-baseline gap-3">
          <span className="truncate font-display text-base font-medium text-ink">
            {mod.about.name || mod.folder}
          </span>
        </div>
        {(mod.schematic?.shortDescription || mod.about.description) && (
          <p className="line-clamp-2 text-sm text-muted">
            {mod.schematic?.shortDescription || mod.about.description}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
          {updated && <span>Updated {updated}</span>}
          {created && <span>Created {created}</span>}
          {mod.publishedFileId && (
            <span className="text-accent">Published</span>
          )}
        </div>
      </div>
    </button>
  );
}

function formatRelative(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return formatDate(ms);
}

function formatDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}
