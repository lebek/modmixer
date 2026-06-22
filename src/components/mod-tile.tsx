import type { WorkspaceMod } from '../agent/workspace';
import { getGame } from '../agent/games/registry';
import { useModPreview } from '@/lib/use-mod-preview';
import { formatDate, formatRelative } from '@/lib/format-date';

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
          {mod.prefs.game !== 'rimworld' && (
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${getGame(mod.prefs.game).badgeClassName}`}
            >
              {getGame(mod.prefs.game).displayName}
            </span>
          )}
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
