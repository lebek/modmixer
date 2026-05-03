// Manual + scheduled update flow for Modmixer.
//
// `update-electron-app` already wires up the periodic poll + the OS-native
// "restart now?" dialog when an update finishes downloading. This module
// piggybacks on the same Electron `autoUpdater` to expose:
//   - a "Check for updates" action the renderer can fire from Settings
//   - a state stream so the UI can show progress (checking → downloading →
//     ready-to-install / up-to-date / error)
//
// In dev (`!app.isPackaged`) and on Linux, `update-electron-app` never calls
// `setFeedURL`, so triggering `checkForUpdates()` would blow up. We track
// that by gating on the same conditions and reporting a friendly
// "unsupported" state instead.

import { app, autoUpdater, BrowserWindow } from 'electron';
import { updateElectronApp } from 'update-electron-app';

export type UpdaterStatus =
  | 'idle'
  | 'unsupported'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloaded'
  | 'error';

export interface UpdaterState {
  status: UpdaterStatus;
  /** Reason the updater is unsupported on this build. Set when status='unsupported'. */
  unsupportedReason?: 'dev' | 'platform';
  /** Last error message; cleared on the next successful check. */
  errorMessage?: string;
  /** Release name for the downloaded update, when known. */
  releaseName?: string;
  /** Timestamp (ms since epoch) of the last completed check. */
  lastCheckedAt?: number;
}

const SUPPORTED_PLATFORMS: NodeJS.Platform[] = ['darwin', 'win32'];

let state: UpdaterState = { status: 'idle' };
let getWindow: (() => BrowserWindow | null) | null = null;
let initialized = false;

function broadcast(): void {
  const win = getWindow?.();
  if (win && !win.isDestroyed()) {
    win.webContents.send('modmixer:updater:state', state);
  }
}

function setState(patch: Partial<UpdaterState>): void {
  state = { ...state, ...patch };
  broadcast();
}

export function initUpdater(windowGetter: () => BrowserWindow | null): void {
  if (initialized) return;
  initialized = true;
  getWindow = windowGetter;

  if (!app.isPackaged) {
    state = { status: 'unsupported', unsupportedReason: 'dev' };
    return;
  }
  if (!SUPPORTED_PLATFORMS.includes(process.platform)) {
    state = { status: 'unsupported', unsupportedReason: 'platform' };
    return;
  }

  // Boot the standard auto-update flow: feed URL + 1-hour poll + the OS
  // "restart now?" dialog when a download completes.
  updateElectronApp({
    repo: 'lebek/modmixer',
    updateInterval: '1 hour',
  });

  autoUpdater.on('checking-for-update', () => {
    setState({ status: 'checking', errorMessage: undefined });
  });
  autoUpdater.on('update-available', () => {
    setState({ status: 'available', errorMessage: undefined });
  });
  autoUpdater.on('update-not-available', () => {
    setState({
      status: 'not-available',
      lastCheckedAt: Date.now(),
      errorMessage: undefined,
    });
  });
  autoUpdater.on(
    'update-downloaded',
    (_event, _releaseNotes, releaseName: string) => {
      setState({
        status: 'downloaded',
        releaseName,
        lastCheckedAt: Date.now(),
        errorMessage: undefined,
      });
    },
  );
  autoUpdater.on('error', (err: Error) => {
    setState({
      status: 'error',
      errorMessage: err?.message ?? String(err),
      lastCheckedAt: Date.now(),
    });
  });
}

export function getUpdaterState(): UpdaterState {
  return state;
}

export function checkForUpdates(): UpdaterState {
  if (state.status === 'unsupported') return state;
  if (state.status === 'checking') return state;
  // If the user already has a downloaded update sitting on disk, don't
  // restart the flow — let them act on the existing "ready to install" state.
  if (state.status === 'downloaded') return state;
  try {
    autoUpdater.checkForUpdates();
  } catch (err) {
    setState({
      status: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
      lastCheckedAt: Date.now(),
    });
  }
  return state;
}

export function quitAndInstall(): void {
  if (state.status !== 'downloaded') return;
  autoUpdater.quitAndInstall();
}
