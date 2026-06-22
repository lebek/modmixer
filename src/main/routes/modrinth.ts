import { getWorkspaceMod } from '../../agent/workspace.js';
import { emitModChanged } from '../../agent/mod-events.js';
import { writeModPrefs } from '../../agent/mod-prefs.js';
import { buildMod } from '../../agent/minecraft/gradle.js';
import {
  getModrinthToken,
  setModrinthToken,
  hasModrinthToken,
  publishToModrinth,
  type ModrinthPublishMeta,
  type ModrinthVersionMeta,
  type ModrinthPublishProgressEvent,
} from '../../agent/minecraft/modrinth.js';
import type { RouteContext } from './context.js';

/**
 * Modrinth publishing for Minecraft mods — the Modrinth analogue of the Steam
 * Workshop routes. Token storage + a publish handler that builds the jar then
 * uploads via the Modrinth client, streaming progress to the renderer on the
 * `modmixer:modrinth:progress` channel (mirrors workshop:progress).
 */
export function registerModrinthRoutes(ctx: RouteContext): void {
  const { ipc, getWindow } = ctx;

  ipc.handle('modmixer:modrinth:get-token', () => getModrinthToken());
  ipc.handle('modmixer:modrinth:has-token', () => hasModrinthToken());
  ipc.handle('modmixer:modrinth:set-token', (_evt, token: string) => {
    setModrinthToken(token);
    return hasModrinthToken();
  });

  ipc.handle(
    'modmixer:modrinth:publish',
    async (
      _evt,
      folder: string,
      meta: ModrinthPublishMeta,
      version: ModrinthVersionMeta,
    ) => {
      const mod = await getWorkspaceMod(folder);
      if (!mod) throw new Error(`Mod not found: ${folder}`);
      const win = getWindow();
      const emit = (event: ModrinthPublishProgressEvent) =>
        win?.webContents.send('modmixer:modrinth:progress', { folder, ...event });

      emit({ status: 'preparing' });
      // Build the shippable jar first; a publish must reflect current code.
      const build = await buildMod(mod.workspacePath);
      if (!build.ok || !build.jarPath) {
        const error = 'Build failed — fix compile errors before publishing.';
        emit({ status: 'error', error });
        throw new Error(error);
      }

      const result = await publishToModrinth({
        jarPath: build.jarPath,
        projectId: mod.prefs.modrinthProjectId,
        meta,
        version,
        onProgress: emit,
      });

      await writeModPrefs(folder, {
        modrinthProjectId: result.projectId,
        modrinthSlug: result.slug,
        modrinthVersion: version.versionNumber,
        lastPublishedAt: Date.now(),
      });
      emitModChanged(folder);
      return result;
    },
  );
}
