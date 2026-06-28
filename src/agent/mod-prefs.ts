import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { getWorkspacePaths } from './workspace.js';
import type { GameId } from './games/types.js';
import { DEFAULT_GAME_ID, resolveGameId } from './games/registry.js';
import type { ModrinthSideSupport } from './minecraft/modrinth.js';

/**
 * The Modrinth project metadata last used to publish a Minecraft mod. Unlike
 * the manifest fields (which live in gradle.properties and travel inside the
 * jar), Modrinth-only fields — summary, slug, categories, side support — have
 * no home in the mod itself, so we remember them here. Persisting the whole set
 * lets the publish panel re-seed its form after the first publish instead of
 * losing the values (title/description are also stored so the panel reloads
 * from one place). Read-only on update: a re-publish only uploads a new version
 * and never pushes these back to Modrinth (edits made on modrinth.com win).
 */
export interface ModrinthSavedMeta {
  title: string;
  summary: string;
  description: string;
  slug: string;
  license: string;
  categories: string[];
  clientSide: ModrinthSideSupport;
  serverSide: ModrinthSideSupport;
}

/**
 * Per-mod *user* preferences. Unlike the Schematic (agent-owned and rewritten
 * as the mod evolves), this sidecar holds the user's own toggles for a mod and
 * is never touched by the agent — so a setting like "track on the leaderboard"
 * survives every agent rewrite. Lives under .modmixer/ alongside the schematic
 * so it never ships to the Steam Workshop (PUBLISH_EXCLUDES strips .modmixer).
 */
export interface ModPrefs {
  /**
   * Whether a successful Steam Workshop publish also registers this mod on the
   * Modmixer leaderboard (modmixer.com). Defaults to true; persisted from the
   * publish dialog's checkbox at publish time.
   */
  trackOnLeaderboard: boolean;
  /**
   * Epoch ms of the most recent successful Steam Workshop publish from
   * Modmixer, or null if this mod has never been published here. Stamped on
   * publish success so the publish panel can show "last published" — note it
   * only tracks publishes made through Modmixer, not Steam-side edits.
   */
  lastPublishedAt: number | null;
  /**
   * Which game this mod targets. Set once at creation and never changed (a mod
   * is for exactly one game). Missing on mods created before multi-game support,
   * which read back as 'rimworld' — so every pre-existing mod stays a RimWorld
   * mod with no migration.
   */
  game: GameId;
  /**
   * Modrinth project id (Minecraft mods), stamped on first publish. Reusing it
   * on the next publish updates the existing project (skipping re-review) rather
   * than creating a new one. Undefined until first published to Modrinth.
   */
  modrinthProjectId?: string;
  /** Modrinth project slug, for building the public URL. */
  modrinthSlug?: string;
  /**
   * Version number of the most recent successful Modrinth publish. Used to
   * pre-fill the publish dialog with the next patch bump — Modrinth rejects a
   * duplicate version, so each update must increment. Undefined until first
   * published.
   */
  modrinthVersion?: string;
  /**
   * The Modrinth project metadata last published from Modmixer. Stamped on
   * every successful Modrinth publish so the publish panel can re-seed its form
   * (Modrinth-only fields like summary/slug/categories have nowhere else to
   * live). Undefined until first published to Modrinth.
   */
  modrinthMeta?: ModrinthSavedMeta;
}

const SIDECAR_DIR = '.modmixer';
const SIDECAR_FILE = 'prefs.json';

function defaults(): ModPrefs {
  return {
    trackOnLeaderboard: true,
    lastPublishedAt: null,
    game: DEFAULT_GAME_ID,
  };
}

function sidecarPath(folder: string): string {
  const { workspaceDir } = getWorkspacePaths();
  return path.join(workspaceDir, folder, SIDECAR_DIR, SIDECAR_FILE);
}

function asSide(v: unknown): ModrinthSideSupport {
  return v === 'optional' || v === 'unsupported' ? v : 'required';
}

/** Tolerant parse of the persisted Modrinth metadata (user-editable on disk). */
function parseModrinthMeta(v: unknown): ModrinthSavedMeta | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  const str = (x: unknown): string => (typeof x === 'string' ? x : '');
  return {
    title: str(r.title),
    summary: str(r.summary),
    description: str(r.description),
    slug: str(r.slug),
    license: str(r.license),
    categories: Array.isArray(r.categories)
      ? r.categories.filter((c): c is string => typeof c === 'string')
      : [],
    clientSide: asSide(r.clientSide),
    serverSide: asSide(r.serverSide),
  };
}

function parsePrefs(raw: string): ModPrefs {
  try {
    const parsed = JSON.parse(raw) as Partial<ModPrefs>;
    return {
      trackOnLeaderboard:
        typeof parsed.trackOnLeaderboard === 'boolean'
          ? parsed.trackOnLeaderboard
          : true,
      lastPublishedAt:
        typeof parsed.lastPublishedAt === 'number'
          ? parsed.lastPublishedAt
          : null,
      game: resolveGameId(parsed.game),
      modrinthProjectId:
        typeof parsed.modrinthProjectId === 'string'
          ? parsed.modrinthProjectId
          : undefined,
      modrinthSlug:
        typeof parsed.modrinthSlug === 'string' ? parsed.modrinthSlug : undefined,
      modrinthVersion:
        typeof parsed.modrinthVersion === 'string'
          ? parsed.modrinthVersion
          : undefined,
      modrinthMeta: parseModrinthMeta(parsed.modrinthMeta),
    };
  } catch {
    return defaults();
  }
}

/**
 * Read a workspace mod's prefs. Always resolves to a usable shape: a missing
 * or corrupt sidecar yields defaults rather than null, so callers never have
 * to branch (the publish flow has already resolved the mod by this point).
 */
export async function readModPrefs(folder: string): Promise<ModPrefs> {
  const file = sidecarPath(folder);
  if (!fs.existsSync(file)) return defaults();
  try {
    return parsePrefs(await fsp.readFile(file, 'utf8'));
  } catch {
    return defaults();
  }
}

export async function writeModPrefs(
  folder: string,
  patch: Partial<ModPrefs>,
): Promise<ModPrefs> {
  const { workspaceDir } = getWorkspacePaths();
  const modDir = path.join(workspaceDir, folder);
  const current = await readModPrefs(folder);
  const next: ModPrefs = {
    trackOnLeaderboard:
      typeof patch.trackOnLeaderboard === 'boolean'
        ? patch.trackOnLeaderboard
        : current.trackOnLeaderboard,
    lastPublishedAt:
      'lastPublishedAt' in patch
        ? patch.lastPublishedAt ?? null
        : current.lastPublishedAt,
    // game is set once at creation; only overwrite when explicitly patched.
    game: patch.game ? resolveGameId(patch.game) : current.game,
    modrinthProjectId:
      'modrinthProjectId' in patch
        ? patch.modrinthProjectId
        : current.modrinthProjectId,
    modrinthSlug:
      'modrinthSlug' in patch ? patch.modrinthSlug : current.modrinthSlug,
    modrinthVersion:
      'modrinthVersion' in patch
        ? patch.modrinthVersion
        : current.modrinthVersion,
    modrinthMeta:
      'modrinthMeta' in patch ? patch.modrinthMeta : current.modrinthMeta,
  };
  await fsp.mkdir(path.join(modDir, SIDECAR_DIR), { recursive: true });
  await fsp.writeFile(
    sidecarPath(folder),
    JSON.stringify(next, null, 2),
    'utf8',
  );
  return next;
}
