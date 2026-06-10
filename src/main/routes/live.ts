import { launchLiveSession } from '../../agent/live/session.js';
import { getLiveServer } from '../../agent/live/server.js';
import type { LiveConnectionState } from '../../agent/live/protocol.js';
import type { RouteContext } from './context.js';

/**
 * Live sessions — the in-game prompting experiment. One launch entry point
 * plus connection-state plumbing for the renderer's session indicator.
 */
export function registerLiveRoutes(ctx: RouteContext): void {
  const { ipc, getWindow, requireConsent } = ctx;

  ipc.handle('modmixer:live:launch', async () => {
    requireConsent();
    return launchLiveSession();
  });

  ipc.handle('modmixer:live:get-state', () => getLiveServer().getState());

  // Forward connection-state transitions so the renderer can show
  // "game connected / game closed" without polling.
  getLiveServer().on('state', (state: LiveConnectionState) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    if (wc.isDestroyed() || wc.isCrashed()) return;
    try {
      wc.send('modmixer:live:state', state);
    } catch {
      // Render frame disposed mid-send; nothing actionable.
    }
  });
}
