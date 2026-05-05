import fsp from 'node:fs/promises';
import { shell } from 'electron';
import { getMonitorServer } from '../../agent/monitor/server.js';
import { modLoreDir, userLoreDir } from '../../agent/lore.js';
import {
  cancelActiveRebuild,
  getIndexSnapshot,
  startRebuild,
} from '../../agent/index/main-bridge.js';
import type { RouteContext } from './context.js';

/**
 * RimWorld source/def index, in-game monitor bridge, shell open helpers,
 * and the lore-folder reveal escape hatch. None of these share state with
 * the registry/agent stack, so they live together as the "system" routes.
 */
export function registerSystemRoutes(ctx: RouteContext): void {
  const { ipc } = ctx;
  const monitor = getMonitorServer();

  ipc.handle('modmixer:index:get-snapshot', () => getIndexSnapshot());

  ipc.handle('modmixer:index:rebuild', async (_evt, options: { force?: boolean } = {}) =>
    startRebuild(options),
  );

  ipc.handle('modmixer:index:cancel', () => {
    cancelActiveRebuild();
    return getIndexSnapshot();
  });

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

  // Power-user escape hatch from Settings → reveal the user-tier or mod-tier
  // lore directory in Finder/Explorer. Returns null on success (matches
  // shell.openPath's empty-string convention) or an error string for the
  // renderer to surface.
  ipc.handle(
    'modmixer:lore:reveal',
    async (_evt, args: { tier: 'user' | 'mod'; modFolder?: string }) => {
      let dir: string;
      if (args.tier === 'user') {
        dir = userLoreDir();
      } else {
        if (!args.modFolder) return 'modFolder is required for mod-tier lore';
        dir = modLoreDir(args.modFolder);
      }
      // Materialize the directory on first reveal so the user lands inside
      // it instead of seeing "folder does not exist".
      await fsp.mkdir(dir, { recursive: true });
      const err = await shell.openPath(dir);
      return err === '' ? null : err;
    },
  );
}
