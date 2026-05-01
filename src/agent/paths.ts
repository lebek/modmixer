import { homedir, platform } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export interface RimWorldPaths {
  /** Where ModMixer drops new mods (RimWorld picks them up from here on next launch). */
  modsDir: string;
  /** RimWorld install Managed/ folder (contains Assembly-CSharp.dll), if found. */
  managedDir: string | null;
  /**
   * Folder that holds DLC pack subdirs (Core/, Royalty/, Ideology/, …), each
   * with their own Defs/. Layout differs by platform:
   *   - Windows/Linux: <install>/Data/
   *   - macOS:         <bundle>/Contents/Resources/
   * Null when the install can't be found or has no recognisable DLC packs.
   */
  dataDir: string | null;
  /** Steam Workshop subscriptions for RimWorld (294100), if found. */
  workshopDir: string | null;
  /** Player.log location for diagnostics, if found. */
  playerLog: string | null;
  /** ModsConfig.xml — RimWorld's active mod list and load order, if found. */
  modsConfig: string | null;
  /** Prefs.xml — dev mode flag, debug action palette, and other user prefs, if found. */
  prefsXml: string | null;
}

/**
 * Resolve the DLC-pack parent directory by probing the two known layouts.
 * Windows/Linux put packs under a sibling Data/ folder of the engine's
 * <Platform>_Data/Managed/ DLL dir; macOS puts Managed inside Resources/Data/
 * with packs as siblings under Resources/. Returns null when neither shape
 * has a Core/Defs/ where we expect it.
 */
function detectDataDir(managedDir: string): string | null {
  const installRoot = path.dirname(path.dirname(managedDir));
  const candidates = [
    path.join(installRoot, 'Data'),
    installRoot,
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'Core', 'Defs'))) return c;
  }
  return null;
}

export function detectRimWorldPaths(): RimWorldPaths {
  const home = homedir();
  const os = platform();

  let modsDir: string;
  let managedCandidates: string[] = [];
  let workshopCandidates: string[] = [];
  let playerLogCandidate: string | null = null;
  let modsConfigCandidates: string[] = [];

  if (os === 'darwin') {
    const appSupport = path.join(home, 'Library/Application Support');
    const steamInstall = path.join(
      appSupport,
      'Steam/steamapps/common/RimWorld',
    );
    // RimWorld on Mac scans the install bundle's Mods/ folder for user mods,
    // NOT a user-data path. The legacy "RimWorld by Ludeon Studios/Mods/"
    // location exists on some installs but is not read by RimWorld 1.6 —
    // empirically verified by inspecting where loaded mods (Rim3D, Taters)
    // actually live.
    const bundleMods = path.join(steamInstall, 'RimWorldMac.app/Mods');
    const legacyMods = path.join(
      appSupport,
      'RimWorld by Ludeon Studios/Mods',
    );
    modsDir = fs.existsSync(bundleMods) ? bundleMods : legacyMods;
    managedCandidates = [
      path.join(
        steamInstall,
        'RimWorldMac.app/Contents/Resources/Data/Managed',
      ),
    ];
    workshopCandidates = [
      path.join(appSupport, 'Steam/steamapps/workshop/content/294100'),
    ];
    playerLogCandidate = path.join(
      home,
      'Library/Logs/Ludeon Studios/RimWorld by Ludeon Studios/Player.log',
    );
    // On Mac, mods live at "RimWorld by Ludeon Studios/Mods/" but config (and
    // saves) live at "RimWorld/Config/" — different parent directories. Older
    // installs may use the longer name; probe both.
    modsConfigCandidates = [
      path.join(appSupport, 'RimWorld/Config/ModsConfig.xml'),
      path.join(appSupport, 'RimWorld by Ludeon Studios/Config/ModsConfig.xml'),
    ];
  } else if (os === 'win32') {
    const userProfile = process.env.USERPROFILE ?? home;
    const userBase = path.join(
      userProfile,
      'AppData/LocalLow/Ludeon Studios/RimWorld by Ludeon Studios',
    );
    modsDir = path.join(userBase, 'Mods');
    managedCandidates = [
      'C:/Program Files (x86)/Steam/steamapps/common/RimWorld/RimWorldWin64_Data/Managed',
      'C:/Program Files/Steam/steamapps/common/RimWorld/RimWorldWin64_Data/Managed',
    ];
    workshopCandidates = [
      'C:/Program Files (x86)/Steam/steamapps/workshop/content/294100',
      'C:/Program Files/Steam/steamapps/workshop/content/294100',
    ];
    playerLogCandidate = path.join(userBase, 'Player.log');
    modsConfigCandidates = [path.join(userBase, 'Config/ModsConfig.xml')];
  } else {
    const linuxBase = path.join(
      home,
      '.config/unity3d/Ludeon Studios/RimWorld by Ludeon Studios',
    );
    modsDir = path.join(linuxBase, 'Mods');
    managedCandidates = [
      path.join(
        home,
        '.steam/steam/steamapps/common/RimWorld/RimWorldLinux_Data/Managed',
      ),
    ];
    workshopCandidates = [
      path.join(home, '.steam/steam/steamapps/workshop/content/294100'),
    ];
    modsConfigCandidates = [path.join(linuxBase, 'Config/ModsConfig.xml')];
  }

  const modsConfig = modsConfigCandidates.find((p) => fs.existsSync(p)) ?? null;
  // Prefs.xml lives next to ModsConfig.xml in the same Config/ dir on every
  // platform. The user may not have it yet (game never launched), in which
  // case we still report a candidate path so the prepare-debug-session tool
  // can surface a clear error rather than no-oping silently.
  const prefsCandidate = modsConfig
    ? path.join(path.dirname(modsConfig), 'Prefs.xml')
    : null;
  const managedDir = managedCandidates.find((p) => fs.existsSync(p)) ?? null;
  return {
    modsDir,
    managedDir,
    dataDir: managedDir ? detectDataDir(managedDir) : null,
    workshopDir: workshopCandidates.find((p) => fs.existsSync(p)) ?? null,
    playerLog:
      playerLogCandidate && fs.existsSync(playerLogCandidate)
        ? playerLogCandidate
        : null,
    modsConfig,
    prefsXml:
      prefsCandidate && fs.existsSync(prefsCandidate) ? prefsCandidate : null,
  };
}
