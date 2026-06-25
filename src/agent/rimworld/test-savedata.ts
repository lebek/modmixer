// Materializes an isolated savedata folder for `-savedatafolder=<path>` test
// launches. RimWorld 1.6 honors the flag for the entire LocalLow/<RimWorld>
// tree (saves, scenarios, Config/) — so writing a reduced ModsConfig.xml here
// lets the user test a workspace mod without ever touching their real mod
// list. Note: -savedatafolder does NOT affect Unity's Player.log location
// (that follows Application.persistentDataPath, which is unaffected by
// RimWorld's own flag), so any forensic Player.log reads work the same way
// regardless of isolated mode.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { detectRimWorldPaths } from '../paths.js';
import { renderModsConfigXml } from '../registry/mods-config.js';

export function getTestSavedataDir(): string {
  return path.join(app.getPath('userData'), 'test-savedata');
}

/** Path to the isolated test session's Prefs.xml (may or may not exist). */
export function getTestSavedataPrefsPath(): string {
  return path.join(getTestSavedataDir(), 'Config', 'Prefs.xml');
}

/**
 * Ensure the isolated test savedata's Prefs.xml exists, seeding it from the
 * user's real Prefs.xml on first run so the test window inherits resolution /
 * audio / dev-mode flag instead of starting in 800x600. Idempotent: a no-op
 * when the file is already present, so subsequent test sessions keep
 * whatever Prefs.xml the prior in-game session wrote.
 *
 * Returns the path on success (file now exists, or already did), null when
 * there's no real Prefs.xml to seed from. Callers that need to edit the test
 * Prefs.xml should use this before doing so, since the agent's `run_test_cycle`
 * flow edits Prefs.xml BEFORE `buildTestSavedata` runs (which previously did
 * the seeding itself).
 */
export async function ensureTestSavedataPrefs(): Promise<string | null> {
  const dst = getTestSavedataPrefsPath();
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst)) return dst;
  const src = detectRimWorldPaths().prefsXml;
  if (!src) return null;
  try {
    await fsp.copyFile(src, dst);
    return dst;
  } catch {
    // Best-effort — RimWorld will regenerate Prefs.xml from defaults if it's
    // missing, just in a small window with default resolution/audio.
    return null;
  }
}

export interface BuildTestSavedataArgs {
  /** Lowercased packageIds in load order. */
  activeMods: string[];
  /** Lowercased DLC packageIds to declare in <knownExpansions>. */
  knownExpansions: string[];
  /** RimWorld version string from the user's real ModsConfig.xml. */
  version: string;
}

export interface TestSavedata {
  /** Absolute path to pass as `-savedatafolder=<dir>`. */
  savedataDir: string;
  /** Path to the ModsConfig.xml we just wrote (for diagnostics). */
  configPath: string;
}

/**
 * Write `Config/ModsConfig.xml` for an isolated test launch. Prefs.xml is
 * seeded separately by `ensureTestSavedataPrefs()` — `run_test_cycle` calls
 * that BEFORE editing Prefs (dev mode + palette pins), then ships the mod
 * here. We still call it defensively in case some other caller bypasses
 * `run_test_cycle`.
 */
export async function buildTestSavedata(
  args: BuildTestSavedataArgs,
): Promise<TestSavedata> {
  const savedataDir = getTestSavedataDir();
  const configDir = path.join(savedataDir, 'Config');
  await fsp.mkdir(configDir, { recursive: true });

  const configPath = path.join(configDir, 'ModsConfig.xml');
  const xml = renderModsConfigXml({
    version: args.version,
    activeMods: args.activeMods,
    knownExpansions: args.knownExpansions,
  });
  await atomicWrite(configPath, xml);

  await ensureTestSavedataPrefs();

  return { savedataDir, configPath };
}

/** Wipe the test savedata dir. Used by a "reset test session" UI action. */
export async function resetTestSavedata(): Promise<void> {
  const dir = getTestSavedataDir();
  await fsp.rm(dir, { recursive: true, force: true });
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  const tmp = `${file}.modmixer-tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, contents, 'utf8');
  await fsp.rename(tmp, file);
}
