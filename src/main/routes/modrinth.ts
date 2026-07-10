import { getWorkspaceMod } from '../../agent/workspace.js';
import { emitModChanged } from '../../agent/mod-events.js';
import { writeModPrefs } from '../../agent/mod-prefs.js';
import { buildMod } from '../../agent/minecraft/gradle.js';
import { writeMinecraftMeta } from '../../agent/minecraft/scaffold.js';
import { syncLicenseFile } from '../../agent/license-file.js';
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
      // Project metadata from the first-publish dialog; null on updates —
      // after creation the project is owned and edited on modrinth.com.
      meta: ModrinthPublishMeta | null,
      version: ModrinthVersionMeta,
    ) => {
      const mod = await getWorkspaceMod(folder);
      if (!mod) throw new Error(`Mod not found: ${folder}`);
      const isRepublish = !!mod.prefs.modrinthProjectId;
      if (!isRepublish && !meta) {
        throw new Error('Project details are required for a first publish.');
      }
      const win = getWindow();
      const emit = (event: ModrinthPublishProgressEvent) =>
        win?.webContents.send('modmixer:modrinth:progress', { folder, ...event });

      emit({ status: 'preparing' });
      // Bake the version into gradle.properties before building: Gradle names
      // the jar <mod_id>-<mod_version>.jar and expands ${mod_version} into the
      // in-jar neoforge.mods.toml, so without this every release would ship
      // with the scaffold-time version. Validate first — the version lands
      // inside a quoted toml string and NeoForge wants a maven-ish form.
      const versionNumber = version.versionNumber.trim();
      if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(versionNumber)) {
        const error = `Invalid version number "${version.versionNumber}" — use letters, digits, dots, hyphens (e.g. 1.0.1).`;
        emit({ status: 'error', error });
        throw new Error(error);
      }
      try {
        const changed = await writeMinecraftMeta(mod.workspacePath, {
          version: versionNumber,
          // First publish sets the project license (Modrinth's license_id); bake
          // the same id into gradle mod_license so the in-jar manifest agrees.
          ...(meta ? { license: meta.license } : {}),
        });
        if (changed.length > 0) emitModChanged(folder);
      } catch (err) {
        const error = (err as Error).message;
        emit({ status: 'error', error });
        throw new Error(error);
      }

      // Keep a human-readable LICENSE file in the source tree in step with the
      // chosen license. Best-effort — the manifest license above is what ships
      // in the jar, so a file-write hiccup must not fail the publish.
      if (meta) {
        try {
          await syncLicenseFile(mod.workspacePath, meta.license, {
            author: mod.about.author,
            year: new Date().getFullYear(),
          });
        } catch (err) {
          console.warn('[modrinth] LICENSE file write failed:', err);
        }
      }

      // Build the shippable jar; a publish must reflect current code.
      const build = await buildMod(mod.workspacePath);
      if (!build.ok || !build.jarPath) {
        const error = 'Build failed — fix compile errors before publishing.';
        emit({ status: 'error', error });
        throw new Error(error);
      }

      const result = await publishToModrinth({
        jarPath: build.jarPath,
        projectId: mod.prefs.modrinthProjectId,
        meta: meta ?? undefined,
        version: { ...version, versionNumber },
        onProgress: emit,
      });

      // The project id is the only Modrinth state worth keeping: it links
      // updates to the project and builds the public URL (ids resolve on
      // modrinth.com and, unlike slugs, can't be renamed on the site).
      await writeModPrefs(folder, {
        modrinthProjectId: result.projectId,
        modrinthVersion: versionNumber,
        lastPublishedAt: Date.now(),
      });
      emitModChanged(folder);
      return result;
    },
  );
}
