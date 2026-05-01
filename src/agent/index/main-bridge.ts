import type { BrowserWindow } from 'electron';
import {
  cancelRebuild,
  getIndexStatus,
  isRebuilding,
  rebuildIndex,
  type IndexStatus,
} from './rebuild.js';
import type { IndexProgressEvent } from './progress.js';

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
  void rebuildIndex(emit, options).catch(() => {
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
 */
export async function ensureIndexAtStartup(): Promise<void> {
  const status = getIndexStatus();
  if (status.type === 'fresh' || status.type === 'no-rimworld') return;
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
