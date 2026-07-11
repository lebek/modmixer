import { useState } from 'react';
import type { WorkspaceMod } from '../agent/workspace';
import type { GameId } from '../agent/games/types';
import { getGame, resolveGameId } from '../agent/games/registry';
import { ModTile } from './mod-tile';
import { byUpdatedDesc } from '@/lib/sort-mods';
import { cn } from '@/lib/cn';

/** Home's "filter by published" control — a mod counts as published once it has a Workshop/Modrinth id. */
type PublishFilter = 'all' | 'published' | 'unpublished';

export function ModsView({
  game,
  mods,
  onOpen,
  onNewMod,
  onImportMod,
  onLaunchLiveSession,
  onSetModPrefs,
}: {
  /** The app-level active game — Home is a lens onto this game's mods. */
  game: GameId;
  mods: WorkspaceMod[];
  onOpen: (folder: string) => void;
  onNewMod: (game?: GameId) => void;
  onImportMod: () => void;
  onLaunchLiveSession: () => Promise<void>;
  /** Persist a pin/archive toggle for one mod (writes the prefs sidecar). */
  onSetModPrefs: (
    folder: string,
    patch: { pinned?: boolean; archived?: boolean },
  ) => void;
}) {
  const def = getGame(game);
  // Home is scoped to the active game; mods for other games live behind their
  // own selection (their tabs stay open regardless).
  const gameMods = mods.filter((m) => resolveGameId(m.prefs.game) === game);
  // A mod counts as published once it has a Workshop item id backing it.
  const publishedCount = gameMods.filter((m) => m.publishedFileId != null).length;

  const [query, setQuery] = useState('');
  const [publishFilter, setPublishFilter] = useState<PublishFilter>('all');
  const [archiveOpen, setArchiveOpen] = useState(false);

  // Launching quits/starts RimWorld in the main process and takes several
  // seconds — keep the button disabled with a busy label until it settles
  // (errors are surfaced by the handler itself).
  const [launching, setLaunching] = useState(false);
  const launchLive = async () => {
    setLaunching(true);
    try {
      await onLaunchLiveSession();
    } finally {
      setLaunching(false);
    }
  };
  // Importing an existing folder is RimWorld-only for now (it synthesises an
  // About.xml; NeoForge project import is a fast-follow).
  const canImport = def.capabilities.folderImport;

  const q = query.trim().toLowerCase();
  const matches = (m: WorkspaceMod): boolean => {
    if (publishFilter === 'published' && m.publishedFileId == null) return false;
    if (publishFilter === 'unpublished' && m.publishedFileId != null) return false;
    if (!q) return true;
    const haystack = [
      m.about.name,
      m.folder,
      m.about.description,
      m.schematic?.shortDescription ?? '',
      m.about.packageId,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  };

  const filtered = gameMods.filter(matches);
  // Pinned mods aren't a separate section — they just float to the top of the
  // one main list, ahead of the rest (each still ordered by recency).
  const main = filtered
    .filter((m) => !m.prefs.archived)
    .sort((a, b) => {
      if (a.prefs.pinned !== b.prefs.pinned) return a.prefs.pinned ? -1 : 1;
      return byUpdatedDesc(a, b);
    });
  const archived = filtered.filter((m) => m.prefs.archived).sort(byUpdatedDesc);
  // A live search should surface archived matches too, so force the section
  // open while the user is typing.
  const showArchive = archiveOpen || q !== '';

  const tile = (m: WorkspaceMod) => (
    <ModTile
      key={m.folder}
      mod={m}
      onClick={() => onOpen(m.folder)}
      onTogglePin={(pin) => onSetModPrefs(m.folder, { pinned: pin })}
      onToggleArchive={(arch) => onSetModPrefs(m.folder, { archived: arch })}
    />
  );

  return (
    <div className="flex-1 overflow-auto px-8 py-8">
      <div className="mx-auto max-w-5xl">
        {gameMods.length > 0 && (
          <div className="mb-8 flex items-center gap-12 border-b border-line pb-6">
            <Stat label="Mods created" value={gameMods.length} />
            <Stat label="Published" value={publishedCount} />
          </div>
        )}

        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="font-display text-xl font-medium text-ink">
              Your {def.displayName} mods
            </h2>
            <p className="text-sm text-muted">
              {def.displayName} mods you've built in Modmixer.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {def.capabilities.liveSession && (
              <button
                onClick={() => void launchLive()}
                disabled={launching}
                title="Start RimWorld in a sandboxed test colony and prompt Modmixer from inside the game. Experimental."
                className="rounded-md border border-line bg-paper px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/40 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                {launching ? (
                  'launching…'
                ) : (
                  <>
                    launch live session{' '}
                    <span className="ml-1 rounded-sm bg-warning/15 px-1 py-0.5 text-[9px] text-warning">
                      experimental
                    </span>
                  </>
                )}
              </button>
            )}
            {canImport && (
              <button
                onClick={onImportMod}
                className="rounded-md border border-line bg-paper px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/40 hover:text-ink"
              >
                import mod
              </button>
            )}
            <NewModButton game={game} onNewMod={onNewMod} />
          </div>
        </div>

        {gameMods.length === 0 ? (
          <EmptyState
            game={game}
            canImport={canImport}
            onNewMod={onNewMod}
            onImportMod={onImportMod}
          />
        ) : (
          <>
            {/* Low-emphasis toolbar: search stays a lone icon until clicked,
                the published filter is plain ghost text — deliberately quiet so
                it doesn't compete with the mod list. */}
            <div className="mb-5 flex items-center justify-end gap-4">
              <SearchControl
                value={query}
                onChange={setQuery}
                placeholder={`Search ${def.displayName} mods…`}
              />
              <span aria-hidden className="h-4 w-px bg-line" />
              <PublishedFilter value={publishFilter} onChange={setPublishFilter} />
            </div>

            {filtered.length === 0 ? (
              <NoResults
                onClear={() => {
                  setQuery('');
                  setPublishFilter('all');
                }}
              />
            ) : (
              <div className="space-y-8">
                {main.length > 0 && <Grid>{main.map(tile)}</Grid>}

                {archived.length > 0 && (
                  <section>
                    <button
                      onClick={() => setArchiveOpen((o) => !o)}
                      className="mb-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:text-ink"
                      aria-expanded={showArchive}
                    >
                      <Chevron open={showArchive} />
                      Archived
                      <span className="rounded-full bg-raised/70 px-1.5 py-0.5 text-[10px] text-subtle">
                        {archived.length}
                      </span>
                    </button>
                    {showArchive && <Grid>{archived.map(tile)}</Grid>}
                  </section>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-stretch gap-3 md:grid-cols-2">
      {children}
    </div>
  );
}

/**
 * Search that stays out of the way: a single magnifier button until you click
 * it (or there's an active query), then a slim inline input that collapses
 * again on blur when empty.
 */
function SearchControl({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const expanded = open || value !== '';

  if (!expanded) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="Search mods"
        title="Search mods"
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised/60 hover:text-ink"
      >
        <SearchGlyph />
      </button>
    );
  }

  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle">
        <SearchGlyph />
      </span>
      <input
        type="text"
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (value === '') setOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onChange('');
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        aria-label="Search mods"
        className="w-64 rounded-md border border-line bg-paper py-1.5 pl-8 pr-8 text-sm text-ink placeholder:text-subtle focus:border-ink/40 focus:outline-none"
      />
      {value && (
        <button
          onClick={() => {
            onChange('');
            setOpen(false);
          }}
          aria-label="Clear search"
          title="Clear search"
          className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-subtle transition-colors hover:bg-ink/10 hover:text-ink"
        >
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="h-3 w-3"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      )}
    </div>
  );
}

function SearchGlyph() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function PublishedFilter({
  value,
  onChange,
}: {
  value: PublishFilter;
  onChange: (v: PublishFilter) => void;
}) {
  const options: { value: PublishFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'published', label: 'Published' },
    { value: 'unpublished', label: 'Unpublished' },
  ];
  return (
    <div className="flex items-center gap-3">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className={cn(
            'font-mono text-[11px] uppercase tracking-[0.14em] transition-colors',
            value === opt.value
              ? 'text-ink'
              : 'text-subtle hover:text-muted',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-3 w-3 transition-transform', open && 'rotate-90')}
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

function NoResults({ onClear }: { onClear: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-surface/30 p-10 text-center">
      <p className="text-sm text-muted">No mods match your filters.</p>
      <button
        onClick={onClear}
        className="mt-3 rounded-md border border-line bg-paper px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/40 hover:text-ink"
      >
        clear filters
      </button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <span className="font-display text-4xl font-medium leading-none text-ink">
        {value}
      </span>
      <span className="mt-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
        {label}
      </span>
    </div>
  );
}

/**
 * "+ new {game} mod" — creates a mod for the app's active game (each mod
 * targets one game). A game that hasn't been set up yet (paths discovered,
 * index built) kicks off its setup the first time you create a mod for it.
 */
function NewModButton({
  game,
  onNewMod,
}: {
  game: GameId;
  onNewMod: (game?: GameId) => void;
}) {
  return (
    <button
      data-demo="new-mod"
      onClick={() => onNewMod(game)}
      className="rounded-md bg-accent px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-accent-foreground transition-colors hover:bg-accent-soft"
    >
      + new {getGame(game).displayName} mod
    </button>
  );
}

function EmptyState({
  game,
  canImport,
  onNewMod,
  onImportMod,
}: {
  game: GameId;
  canImport: boolean;
  onNewMod: (game?: GameId) => void;
  onImportMod: () => void;
}) {
  const def = getGame(game);
  return (
    <div className="rounded-lg border border-dashed border-line bg-surface/30 p-10 text-center">
      <h3 className="font-display text-base font-medium text-ink">
        No {def.displayName} mods yet
      </h3>
      <p className="mt-1 text-sm text-muted">
        Start a chat with the agent and describe what you want to build
        {canImport ? ', or import an existing mod folder' : ''}.
      </p>
      {def.beta && (
        <p className="mx-auto mt-1 max-w-md text-xs text-subtle">
          {def.displayName} sets itself up automatically the first time you
          create a mod for it.
        </p>
      )}
      <div className="mt-4 flex items-center justify-center gap-2">
        <NewModButton game={game} onNewMod={onNewMod} />
        {canImport && (
          <button
            onClick={onImportMod}
            className="rounded-md border border-line bg-paper px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted transition-colors hover:border-ink/40 hover:text-ink"
          >
            import mod
          </button>
        )}
      </div>
    </div>
  );
}
