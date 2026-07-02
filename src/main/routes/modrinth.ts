import { getWorkspaceMod } from '../../agent/workspace.js';
import { emitModChanged } from '../../agent/mod-events.js';
import { writeModPrefs } from '../../agent/mod-prefs.js';
import { buildMod } from '../../agent/minecraft/gradle.js';
import { writeMinecraftMeta } from '../../agent/minecraft/scaffold.js';
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
        });
        if (changed.includes('version')) emitModChanged(folder);
      } catch (err) {
        const error = (err as Error).message;
        emit({ status: 'error', error });
        throw new Error(error);
      }

      // Build the shippable jar; a publish must reflect current code.
      const build = await buildMod(mod.workspacePath);
      if (!build.ok || !build.jarPath) {
        const error = 'Build failed — fix compile errors before publishing.';
        emit({ status: 'error', error });
        throw new Error(error);
      }

      // On re-publish the project slug can't change via the version endpoint
      // (and Modrinth doesn't return it), so reuse the slug we already stored
      // rather than the form's packageId-derived guess — otherwise the "View on
      // Modrinth" URL points at a slug that may not exist.
      const isRepublish = !!mod.prefs.modrinthProjectId;
      const effectiveMeta =
        isRepublish && mod.prefs.modrinthSlug
          ? { ...meta, slug: mod.prefs.modrinthSlug }
          : meta;

      const result = await publishToModrinth({
        jarPath: build.jarPath,
        projectId: mod.prefs.modrinthProjectId,
        meta: effectiveMeta,
        version: { ...version, versionNumber },
        onProgress: emit,
      });

      await writeModPrefs(folder, {
        modrinthProjectId: result.projectId,
        // Only (re)store the slug when we actually learned it from Modrinth (new
        // project creation, or a mod that had none yet). On re-publish keep the
        // known-good stored slug rather than clobbering it with a guess.
        ...(result.projectCreated || !mod.prefs.modrinthSlug
          ? { modrinthSlug: result.slug }
          : {}),
        modrinthVersion: versionNumber,
        lastPublishedAt: Date.now(),
        // Remember the project metadata so the publish panel can re-seed its
        // form after the first publish — Modrinth-only fields (summary, slug,
        // categories, sides) have no home in the jar. Stored from effectiveMeta
        // so the slug matches the one actually published.
        modrinthMeta: {
          title: effectiveMeta.title,
          summary: effectiveMeta.summary,
          description: effectiveMeta.description,
          slug: result.slug || effectiveMeta.slug,
          license: effectiveMeta.license,
          categories: effectiveMeta.categories,
          clientSide: effectiveMeta.clientSide,
          serverSide: effectiveMeta.serverSide,
        },
      });
      emitModChanged(folder);
      return result;
    },
  );
}
