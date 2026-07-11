import type { WorkspaceMod } from '../agent/workspace';
import { getGame } from '../agent/games/registry';
import { useModPreview } from '@/lib/use-mod-preview';
import { formatDate, formatRelative } from '@/lib/format-date';
import { cn } from '@/lib/cn';

export function ModTile({
  mod,
  onClick,
  showGameBadge = false,
  onTogglePin,
  onToggleArchive,
}: {
  mod: WorkspaceMod;
  onClick: () => void;
  /** Show the game badge (on in multi-game mode so every mod is labelled). */
  showGameBadge?: boolean;
  /** Flip the mod's pinned flag. Omit to hide the pin control. */
  onTogglePin?: (pinned: boolean) => void;
  /** Flip the mod's archived flag. Omit to hide the archive control. */
  onToggleArchive?: (archived: boolean) => void;
}) {
  const previewUrl = useModPreview(mod.folder);
  const updated = formatRelative(mod.updatedAt);
  const created = formatDate(mod.createdAt);
  const pinned = mod.prefs.pinned;
  const archived = mod.prefs.archived;
  const description = mod.schematic?.shortDescription || mod.about.description;
  return (
    <div className="group relative h-full">
      <button
        onClick={onClick}
        className={cn(
          'flex h-full w-full gap-3 rounded-lg border bg-surface/40 p-4 text-left transition-colors hover:border-ink/30',
          // Pinned tiles carry a faint accent border so they read as promoted
          // even before you reach the always-visible pin glyph.
          pinned ? 'border-accent/40' : 'border-line',
        )}
      >
        {previewUrl && (
          <div className="aspect-video w-24 shrink-0 overflow-hidden rounded-md border border-line bg-surface/60">
            <img src={previewUrl} alt="" className="h-full w-full object-cover" />
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-baseline gap-3">
            <span className="truncate font-display text-base font-medium text-ink">
              {mod.about.name || mod.folder}
            </span>
            {showGameBadge && (
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide ${getGame(mod.prefs.game).badgeClassName}`}
              >
                {getGame(mod.prefs.game).displayName}
              </span>
            )}
          </div>
          {/* Always reserve two lines for the blurb so tiles keep a uniform
              height whether or not the mod has a description yet. */}
          <p className="line-clamp-2 min-h-[2.5rem] text-sm text-muted">
            {description}
          </p>
          <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle">
            {updated && <span>Updated {updated}</span>}
            {created && <span>Created {created}</span>}
            {mod.publishedFileId && <span className="text-accent">Published</span>}
          </div>
        </div>
      </button>

      {/* Pin/archive controls live as siblings of the tile button (never
          nested — that's invalid and would swallow the tile click) and reveal
          on hover/focus. The pin stays visible while pinned so the state is
          legible at rest. */}
      {(onTogglePin || onToggleArchive) && (
        <div className="absolute right-2 top-2 flex gap-1">
          {onTogglePin && !archived && (
            <TileControl
              label={pinned ? 'Unpin' : 'Pin to top'}
              active={pinned}
              alwaysVisible={pinned}
              onClick={() => onTogglePin(!pinned)}
            >
              <PinIcon filled={pinned} />
            </TileControl>
          )}
          {onToggleArchive && (
            <TileControl
              label={archived ? 'Restore from archive' : 'Archive'}
              onClick={() => onToggleArchive(!archived)}
            >
              {archived ? <UnarchiveIcon /> : <ArchiveIcon />}
            </TileControl>
          )}
        </div>
      )}
    </div>
  );
}

function TileControl({
  label,
  active = false,
  alwaysVisible = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  alwaysVisible?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md border bg-paper/80 backdrop-blur transition-all',
        'focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent',
        active
          ? 'border-accent/40 text-accent'
          : 'border-line text-muted hover:text-ink',
        alwaysVisible
          ? 'opacity-100'
          : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
      )}
    >
      {children}
    </button>
  );
}

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <line x1="12" x2="12" y1="17" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </svg>
  );
}

function UnarchiveIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
    >
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h2" />
      <path d="M20 8v11a2 2 0 0 1-2 2h-2" />
      <path d="m9 15 3-3 3 3" />
      <path d="M12 12v9" />
    </svg>
  );
}
