import type { BrowserWindow } from 'electron';
import type { GameId } from '../games/types.js';
import type { IndexProgressEvent } from './progress.js';

/**
 * Game-tagged setup/index progress hub. Both games' index builds emit the same
 * IndexProgressEvent shape; this fans them out to renderer subscribers tagged
 * with the game, so a single component can render granular per-phase progress
 * for whichever game is being set up.
 *
 * Lives in the index layer (not adapters) so rebuild-minecraft.ts can emit
 * without an adapter→index import cycle. RimWorld bridges its existing
 * onIndexProgress emitter into here once at startup (see main.ts); Minecraft
 * emits directly from its rebuild path.
 */
type Listener = (game: GameId, event: IndexProgressEvent) => void;

const listeners = new Set<Listener>();
const lastByGame: Partial<Record<GameId, IndexProgressEvent | null>> = {};

export function emitSetupProgress(game: GameId, event: IndexProgressEvent): void {
  lastByGame[game] = event;
  for (const l of listeners) l(game, event);
}

export function onSetupProgress(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Most recent progress event for a game, so a freshly-mounted view isn't blank. */
export function getLastSetupProgress(game: GameId): IndexProgressEvent | null {
  return lastByGame[game] ?? null;
}

/**
 * Pipe game-tagged progress to the renderer over a broadcast channel. Wired
 * once for the process lifetime; the listener resolves the live window itself.
 */
export function pipeSetupProgressToWindow(
  getWindow: () => BrowserWindow | null,
  channel = 'modmixer:game-setup:progress',
): () => void {
  return onSetupProgress((game, event) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, { game, event });
  });
}
