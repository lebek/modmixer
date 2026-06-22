import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { getWorkspacePaths } from './workspace.js';
import type { GameId } from './games/types.js';
import { DEFAULT_GAME_ID, resolveGameId } from './games/registry.js';

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
  };
  await fsp.mkdir(path.join(modDir, SIDECAR_DIR), { recursive: true });
  await fsp.writeFile(
    sidecarPath(folder),
    JSON.stringify(next, null, 2),
    'utf8',
  );
  return next;
}
