import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { getWorkspacePaths } from './workspace.js';

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
}

const SIDECAR_DIR = '.modmixer';
const SIDECAR_FILE = 'prefs.json';

function defaults(): ModPrefs {
  return { trackOnLeaderboard: true };
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
  };
  await fsp.mkdir(path.join(modDir, SIDECAR_DIR), { recursive: true });
  await fsp.writeFile(
    sidecarPath(folder),
    JSON.stringify(next, null, 2),
    'utf8',
  );
  return next;
}
