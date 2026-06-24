import { launchLiveSession } from '../../agent/live/session.js';
import { getLiveServer } from '../../agent/live/server.js';
import type { LiveConnectionState } from '../../agent/live/protocol.js';
import { loadSettings } from '../../agent/settings.js';
import { getGame } from '../../agent/games/registry.js';
import type { RouteContext } from './context.js';

/**
 * Live sessions — the in-game prompting experiment. One launch entry point
 * plus connection-state plumbing for the renderer's session indicator.
 */
export function registerLiveRoutes(ctx: RouteContext): void {
  const { ipc, getWindow, requireConsent } = ctx;

  ipc.handle('modmixer:live:launch', async () => {
    requireConsent();
    // Live sessions are a RimWorld-only (Verse bridge) experiment. The UI only
    // shows the launch button when the active game has the liveSession
    // capability; this is the matching server-side guard so the channel can't
    // launch RimWorld for a game that doesn't support it.
    const game = loadSettings().selectedGameId;
    if (!getGame(game).capabilities.liveSession) {
      throw new Error(
        `Live sessions aren't available for ${getGame(game).displayName}.`,
      );
    }
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
