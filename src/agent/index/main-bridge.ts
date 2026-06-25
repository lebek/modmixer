import type { BrowserWindow } from 'electron';
import {
  cancelRebuild,
  getIndexStatus,
  isRebuilding,
  rebuildIndex,
  type IndexStatus,
} from './rebuild.js';
import { resolveIlspycmd } from './ilspycmd.js';
import { warmSearchCache } from './warm-cache.js';
import type { IndexProgressEvent } from './progress.js';
import { loadSettings } from '../settings.js';
import { resolveGameId } from '../games/registry.js';
import { getAdapter } from '../adapters/index.js';

/**
 * The most recent progress event seen, kept on the main side so the renderer
 * can ask "what's happening now?" after navigating to a fresh tab. Cleared
 * to null when no rebuild is active.
 */
let lastProgress: IndexProgressEvent | null = null;

const listeners = new Set<(event: IndexProgressEvent) => void>();

export function onIndexProgress(
  listener: (event: IndexProgressEvent) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: IndexProgressEvent): void {
  lastProgress = event;
  for (const l of listeners) l(event);
}

export function getLastProgress(): IndexProgressEvent | null {
  return lastProgress;
}

/** Snapshot used by the renderer to render the modal/settings status row. */
export interface IndexSnapshot {
  status: IndexStatus;
  rebuilding: boolean;
  lastProgress: IndexProgressEvent | null;
}

export function getIndexSnapshot(): IndexSnapshot {
  return {
    status: getIndexStatus(),
    rebuilding: isRebuilding(),
    lastProgress,
  };
}

/**
 * Trigger a rebuild from the renderer. Concurrent calls are rejected by
 * rebuildIndex itself; we surface that as a no-op rather than an error so
 * the UI doesn't have to special-case it.
 */
export async function startRebuild(options: { force?: boolean } = {}): Promise<IndexSnapshot> {
  if (isRebuilding()) return getIndexSnapshot();
  // Don't await — fire and forget so the IPC returns immediately. Progress
  // events stream over `onIndexProgress`.
  void rebuildIndex(emit, options)
    .then(() => warmSearchCache('rebuild'))
    .catch(() => {
      // rebuildIndex already emitted an error event for us.
    });
  return getIndexSnapshot();
}

/** Public: cancel an in-flight rebuild. */
export function cancelActiveRebuild(): void {
  cancelRebuild();
}

/**
 * Startup hook called by main.ts once the window is up. Triggers a rebuild
 * if the index is stale or absent. Idempotent — safe to call from anywhere.
 *
 * Pre-checks that ilspycmd is resolvable before doing anything else. C# symbol
 * indexing is load-bearing for the agent (search_source, read_symbol,
 * scaffolding against Verse APIs), so a missing decompiler is surfaced as an
 * error event regardless of cache freshness — the modal renders it the same
 * as a build failure.
 */
export async function ensureIndexAtStartup(): Promise<void> {
  // Eagerly (re)build the *active* game's index at launch, dispatched per game:
  // RimWorld needs ilspycmd / .NET decompile (eager build), while Minecraft
  // auto-provisions its toolchain (lazy). resolveGameId coerces an unset value
  // to 'rimworld', so existing RimWorld users are unaffected.
  const game = resolveGameId(loadSettings().selectedGameId);
  await getAdapter(game).index.ensureAtStartup();
}

/**
 * RimWorld's eager startup index build. Only rebuilds on stale/absent — a fresh
 * index just warms the (possibly cold) OS file cache. A missing ilspycmd is
 * surfaced as an error event since the C# index is load-bearing. Bails quietly
 * when no RimWorld install is detected.
 */
export async function ensureRimworldIndexAtStartup(): Promise<void> {
  const status = getIndexStatus();
  if (status.type === 'no-rimworld') return;
  if (!resolveIlspycmd()) {
    emit({
      type: 'error',
      message:
        'ilspycmd not found. Install the .NET SDK and run `dotnet tool install -g ilspycmd`, ' +
        'or vendor a binary at resources/ilspycmd/<platform>-<arch>/. The C# symbol index ' +
        '(search_source, read_symbol, scaffold-mod) cannot work without it.',
    });
    return;
  }
  if (status.type === 'fresh') {
    // Index is usable but the OS file cache / Defender scan cache for it may
    // be cold (reboot, signature update, eviction) — that's a ~40s first
    // search. Pre-pay it in the background now.
    void warmSearchCache('startup');
    return;
  }
  await startRebuild();
}

/**
 * Broadcast an IPC channel name + sender that the main process should pipe
 * progress events into. Lets main.ts wire the listener once without exposing
 * the listener registry to the rest of the app.
 */
export function pipeProgressToWindow(
  getWindow: () => BrowserWindow | null,
  channel = 'modmixer:index:progress',
): () => void {
  return onIndexProgress((event) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, event);
  });
}
