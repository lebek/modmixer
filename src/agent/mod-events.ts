// Tiny event bus for "this mod's metadata changed on disk".
// Used to bridge writes (IPC handler + agent tool) → renderer notifications,
// independent of the Assets watcher (which fires on any file under the mod
// root and conflates concerns).

type Listener = (folder: string) => void;

const listeners = new Set<Listener>();

export function onModChanged(handler: Listener): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

export function emitModChanged(folder: string): void {
  for (const fn of listeners) fn(folder);
}
