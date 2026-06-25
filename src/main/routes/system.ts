import fsp from 'node:fs/promises';
import { shell } from 'electron';
import { getMonitorServer } from '../../agent/monitor/server.js';
import { userLoreDir } from '../../agent/lore.js';
import { getAdapter } from '../../agent/adapters/index.js';
import { getLastSetupProgress } from '../../agent/index/setup-progress.js';
import { resolveGameId } from '../../agent/games/registry.js';
import type { GameId } from '../../agent/games/types.js';
import type { RouteContext } from './context.js';

/**
 * Per-game setup (Settings → Games), in-game monitor bridge, shell open
 * helpers, and the lore-folder reveal escape hatch. None of these share state
 * with the registry/agent stack, so they live together as the "system" routes.
 */
export function registerSystemRoutes(ctx: RouteContext): void {
  const { ipc } = ctx;
  const monitor = getMonitorServer();

  // Per-game setup (Settings → Games). Uniform across games — each game's
  // adapter knows how to read its own toolchain/index state and rebuild.
  ipc.handle(
    'modmixer:game-setup:rebuild',
    (_evt, game: GameId, opts?: { force?: boolean }) =>
      getAdapter(resolveGameId(game)).setup.rebuild(opts),
  );

  // Status + latest progress event in one shot, for the onboarding step and
  // the pre-chat gate (which render granular per-phase progress for any game).
  ipc.handle('modmixer:game-setup:snapshot', async (_evt, game: GameId) => {
    const g = resolveGameId(game);
    return {
      status: await getAdapter(g).setup.getStatus(),
      lastProgress: getLastSetupProgress(g),
    };
  });

  // Prerequisite checks (install/toolchain/paths). Separate from the snapshot
  // because it's the expensive probe — the renderer fetches it on mount + after
  // a fix, not on every build-progress tick.
  ipc.handle('modmixer:game-setup:requirements', (_evt, game: GameId) =>
    getAdapter(resolveGameId(game)).setup.checkRequirements(),
  );

  ipc.handle('modmixer:monitor:get-state', () => monitor.getState());
  ipc.handle('modmixer:monitor:get-snapshot', () => monitor.getLastSnapshot());

  ipc.handle('modmixer:shell:open-external', async (_evt, url: string) => {
    // Allow http(s) for general links, steam:// for Steam client deep-links
    // (e.g. the Workshop legal-agreement page after createItem).
    if (!/^(https?|steam):\/\//i.test(url)) return;
    await shell.openExternal(url);
  });

  ipc.handle('modmixer:shell:open-folder', async (_evt, folder: string) => {
    const err = await shell.openPath(folder);
    return err === '' ? null : err;
  });

  // Power-user escape hatch from Settings → reveal the user lore directory
  // in Finder/Explorer. Returns null on success (matches shell.openPath's
  // empty-string convention) or an error string for the renderer to surface.
  ipc.handle('modmixer:lore:reveal', async () => {
    const dir = userLoreDir();
    // Materialize the directory on first reveal so the user lands inside
    // it instead of seeing "folder does not exist".
    await fsp.mkdir(dir, { recursive: true });
    const err = await shell.openPath(dir);
    return err === '' ? null : err;
  });
}
