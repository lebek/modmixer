import fs from 'node:fs';
import path from 'node:path';
import { getWorkspacePaths } from '../workspace.js';

type Listener = (folder: string) => void;

interface ActiveWatch {
  folder: string;
  watchers: fs.FSWatcher[];
  timer: NodeJS.Timeout | null;
}

const watches = new Map<string, ActiveWatch>();
const listeners = new Set<Listener>();

const WATCH_SUBDIRS = ['Defs', 'Textures', 'Sounds'];
const DEBOUNCE_MS = 250;

export function onAssetsChanged(handler: Listener): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

export function ensureWatching(folder: string): void {
  if (watches.has(folder)) return;
  const { workspaceDir } = getWorkspacePaths();
  const modDir = path.join(workspaceDir, folder);
  if (!fs.existsSync(modDir)) return;

  const active: ActiveWatch = { folder, watchers: [], timer: null };

  const trigger = (filename: string | null) => {
    // Ignore writes inside our own sidecar directory so manifest updates
    // don't cause feedback rescans.
    if (filename && filename.split(path.sep)[0] === '.modmixer') return;
    if (active.timer) clearTimeout(active.timer);
    active.timer = setTimeout(() => {
      active.timer = null;
      for (const fn of listeners) fn(folder);
    }, DEBOUNCE_MS);
  };

  // Watch the mod root itself (covers asset subdirs being created/removed),
  // and each existing asset subdir individually with recursive when supported.
  try {
    const recursiveOk = process.platform === 'darwin' || process.platform === 'win32';
    const w = fs.watch(modDir, { recursive: recursiveOk }, (_evt, name) => trigger(name));
    w.on('error', () => undefined);
    active.watchers.push(w);
    if (!recursiveOk) {
      for (const sub of WATCH_SUBDIRS) {
        const subDir = path.join(modDir, sub);
        if (!fs.existsSync(subDir)) continue;
        const sw = fs.watch(subDir, { recursive: false }, (_evt, name) => trigger(name));
        sw.on('error', () => undefined);
        active.watchers.push(sw);
      }
    }
  } catch {
    // Non-fatal — scanner still works without auto-refresh.
    return;
  }

  watches.set(folder, active);
}

export function stopWatching(folder: string): void {
  const active = watches.get(folder);
  if (!active) return;
  if (active.timer) clearTimeout(active.timer);
  for (const w of active.watchers) {
    try {
      w.close();
    } catch {
      // ignore
    }
  }
  watches.delete(folder);
}

export function stopAllWatches(): void {
  for (const folder of [...watches.keys()]) stopWatching(folder);
}
