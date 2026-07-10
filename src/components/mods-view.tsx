import { useState } from 'react';
import type { WorkspaceMod } from '../agent/workspace';
import type { GameId } from '../agent/games/types';
import { getGame, resolveGameId } from '../agent/games/registry';
import { ModTile } from './mod-tile';
import { byUpdatedDesc } from '@/lib/sort-mods';

export function ModsView({
  game,
  mods,
  onOpen,
  onNewMod,
  onImportMod,
  onLaunchLiveSession,
}: {
  /** The app-level active game — Home is a lens onto this game's mods. */
  game: GameId;
  mods: WorkspaceMod[];
  onOpen: (folder: string) => void;
  onNewMod: (game?: GameId) => void;
  onImportMod: () => void;
  onLaunchLiveSession: () => Promise<void>;
}) {
  const def = getGame(game);
  // Home is scoped to the active game; mods for other games live behind their
  // own selection (their tabs stay open regardless).
  const visible = mods
    .filter((m) => resolveGameId(m.prefs.game) === game)
    .sort(byUpdatedDesc);
  // A mod counts as published once it has a Workshop item id backing it.
  const publishedCount = visible.filter((m) => m.publishedFileId != null).length;
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
  const canImport = getGame(game).capabilities.folderImport;
  return (
    <div className="flex-1 overflow-auto px-8 py-8">
      <div className="mx-auto max-w-5xl">
        {visible.length > 0 && (
          <div className="mb-8 flex items-center gap-12 border-b border-line pb-6">
            <Stat label="Mods created" value={visible.length} />
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

        {visible.length === 0 ? (
          <EmptyState
            game={game}
            canImport={canImport}
            onNewMod={onNewMod}
            onImportMod={onImportMod}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {visible.map((m) => (
              <ModTile key={m.folder} mod={m} onClick={() => onOpen(m.folder)} />
            ))}
          </div>
        )}
      </div>
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
