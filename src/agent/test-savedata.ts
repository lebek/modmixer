// Materializes an isolated savedata folder for `-savedatafolder=<path>` test
// launches. RimWorld 1.6 honors the flag for the entire LocalLow/<RimWorld>
// tree (saves, scenarios, Config/) — so writing a reduced ModsConfig.xml here
// lets the user test a workspace mod without ever touching their real mod
// list. Note: -savedatafolder does NOT affect Unity's Player.log location
// (that follows Application.persistentDataPath, which is unaffected by
// RimWorld's own flag), so log monitoring keeps working unchanged.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { detectRimWorldPaths } from './paths.js';
import { renderModsConfigXml } from './registry/mods-config.js';

export function getTestSavedataDir(): string {
  return path.join(app.getPath('userData'), 'test-savedata');
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
 * Write `Config/ModsConfig.xml` for an isolated test launch. Seeds
 * `Config/Prefs.xml` from the user's real install on first run so the test
 * window inherits resolution / audio / dev-mode flag instead of starting in
 * 800x600. Subsequent runs keep whatever Prefs.xml the previous test session
 * wrote — so toggling dev mode in-test persists across launches.
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

  await seedPrefsIfMissing(configDir);

  return { savedataDir, configPath };
}

/** Wipe the test savedata dir. Used by a "reset test session" UI action. */
export async function resetTestSavedata(): Promise<void> {
  const dir = getTestSavedataDir();
  await fsp.rm(dir, { recursive: true, force: true });
}

async function seedPrefsIfMissing(configDir: string): Promise<void> {
  const dst = path.join(configDir, 'Prefs.xml');
  if (fs.existsSync(dst)) return;
  const src = detectRimWorldPaths().prefsXml;
  if (!src) return;
  try {
    await fsp.copyFile(src, dst);
  } catch {
    // best-effort — RimWorld will regenerate Prefs.xml from defaults if it's
    // missing, just in a small window.
  }
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  const tmp = `${file}.modmixer-tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, contents, 'utf8');
  await fsp.rename(tmp, file);
}
