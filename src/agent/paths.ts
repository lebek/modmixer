import { homedir, platform } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Optional user-supplied override of the RimWorld install location. Set by
 * the onboarding "Browse for install…" button. Cached in module scope so
 * detectRimWorldPaths() (called from many code paths, including ones with no
 * Electron context) doesn't have to reach into settings.ts. main.ts seeds
 * this on boot from settings, and clears/replaces it when the user picks a
 * different folder.
 */
let installOverride: string | null = null;

export function setRimWorldInstallOverride(installRoot: string | null): void {
  installOverride = installRoot && installRoot.length > 0 ? installRoot : null;
}

export function getRimWorldInstallOverride(): string | null {
  return installOverride;
}

export interface RimWorldPaths {
  /** Where ModMixer drops new mods (RimWorld picks them up from here on next launch). */
  modsDir: string;
  /** RimWorld install Managed/ folder (contains Assembly-CSharp.dll), if found. */
  managedDir: string | null;
  /**
   * RimWorld game executable, if the install was found. We launch it directly
   * (not via the Steam URL) so we can pass `-quicktest` and other dev flags.
   * Steam still has to be running for the Steamworks API to initialize, but
   * the launcher in the loop doesn't have to be Steam.
   */
  executable: string | null;
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
function detectExecutable(managedDir: string, os: NodeJS.Platform): string | null {
  // managedDir is <install>/<Platform>_Data/Managed (Win/Linux) or
  // <bundle>/Contents/Resources/Data/Managed (mac). The exe lives at the
  // install root, not next to Managed/.
  if (os === 'win32') {
    const installRoot = path.dirname(path.dirname(managedDir));
    const exe = path.join(installRoot, 'RimWorldWin64.exe');
    return fs.existsSync(exe) ? exe : null;
  }
  if (os === 'linux') {
    const installRoot = path.dirname(path.dirname(managedDir));
    const exe = path.join(installRoot, 'RimWorldLinux');
    return fs.existsSync(exe) ? exe : null;
  }
  // macOS: managedDir = <bundle>/Contents/Resources/Data/Managed.
  // Walk up four levels to the .app bundle, then into Contents/MacOS/.
  const bundle = path.dirname(path.dirname(path.dirname(path.dirname(managedDir))));
  const exe = path.join(bundle, 'Contents', 'MacOS', 'RimWorldMac');
  return fs.existsSync(exe) ? exe : null;
}

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

/**
 * Derive the Steam Workshop content dir from a RimWorld install root.
 * Steam's library layout is `<library>/steamapps/common/<game>` and
 * `<library>/steamapps/workshop/content/<appId>`, so the workshop dir is
 * always two levels up from the install + `workshop/content/294100`. This
 * lets a non-default Steam library (e.g. `E:\SteamLibrary`) resolve its
 * own workshop dir without us hard-coding every drive letter.
 */
function workshopDirFromInstall(installRoot: string): string {
  return path.join(
    path.dirname(path.dirname(installRoot)),
    'workshop/content/294100',
  );
}

/**
 * Sync read of the major.minor RimWorld version from ModsConfig.xml
 * (e.g. "1.6"). Returns null when ModsConfig.xml is missing or unparseable —
 * which happens on a fresh install where RimWorld has never been launched.
 *
 * Used as the default supportedVersions for newly scaffolded mods so users
 * on the latest game version don't get a stale 1.5 default.
 */
export function detectGameVersionMajorMinorSync(): string | null {
  const file = detectRimWorldPaths().modsConfig;
  if (!file) return null;
  try {
    const xml = fs.readFileSync(file, 'utf8');
    const m = xml.match(/<version>\s*([^<]+?)\s*<\/version>/);
    if (!m) return null;
    const mm = m[1].match(/^(\d+)\.(\d+)/);
    return mm ? `${mm[1]}.${mm[2]}` : null;
  } catch {
    return null;
  }
}

export function detectRimWorldPaths(): RimWorldPaths {
  const home = homedir();
  const os = platform();

  let modsDir: string;
  let managedCandidates: string[] = [];
  let workshopCandidates: string[] = [];
  let playerLogCandidate: string | null = null;
  let modsConfigCandidates: string[] = [];

  // The install override (when set) wins over the auto-detected Steam paths.
  // We still probe the standard locations as a fallback so the override can
  // be a partial fix — e.g. user points at a custom Steam library, but the
  // workshop dir is still in the default Steam location.
  const overrideRoot = installOverride;

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
    const overrideBundleMods = overrideRoot
      ? path.join(overrideRoot, 'RimWorldMac.app/Mods')
      : null;
    modsDir =
      overrideBundleMods && fs.existsSync(overrideBundleMods)
        ? overrideBundleMods
        : fs.existsSync(bundleMods)
          ? bundleMods
          : legacyMods;
    managedCandidates = [
      ...(overrideRoot
        ? [path.join(overrideRoot, 'RimWorldMac.app/Contents/Resources/Data/Managed')]
        : []),
      path.join(
        steamInstall,
        'RimWorldMac.app/Contents/Resources/Data/Managed',
      ),
    ];
    workshopCandidates = [
      ...(overrideRoot ? [workshopDirFromInstall(overrideRoot)] : []),
      workshopDirFromInstall(steamInstall),
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
    // RimWorld 1.6 (Verse.ModLister.RebuildModList) scans exactly three
    // locations: <install>/Data/ (official DLCs), <install>/Mods/ (user
    // mods), and Steam Workshop. The LocalLow path many older guides cite
    // is NOT scanned — symlinks dropped there are invisible to the game.
    const winInstalls = [
      ...(overrideRoot ? [overrideRoot] : []),
      'C:/Program Files (x86)/Steam/steamapps/common/RimWorld',
      'C:/Program Files/Steam/steamapps/common/RimWorld',
    ];
    const winInstall = winInstalls.find((p) => fs.existsSync(p));
    modsDir = winInstall
      ? path.join(winInstall, 'Mods')
      : path.join(winInstalls[0], 'Mods');
    managedCandidates = winInstalls.map((p) =>
      path.join(p, 'RimWorldWin64_Data/Managed'),
    );
    workshopCandidates = winInstalls.map(workshopDirFromInstall);
    playerLogCandidate = path.join(userBase, 'Player.log');
    modsConfigCandidates = [path.join(userBase, 'Config/ModsConfig.xml')];
  } else {
    const linuxBase = path.join(
      home,
      '.config/unity3d/Ludeon Studios/RimWorld by Ludeon Studios',
    );
    // Same as Windows: user mods belong in <install>/Mods/, not under
    // ~/.config. RimWorld 1.6's ModLister only scans the install dir.
    const linuxInstalls = [
      ...(overrideRoot ? [overrideRoot] : []),
      path.join(home, '.steam/steam/steamapps/common/RimWorld'),
      path.join(home, '.local/share/Steam/steamapps/common/RimWorld'),
    ];
    const linuxInstall = linuxInstalls.find((p) => fs.existsSync(p));
    modsDir = linuxInstall
      ? path.join(linuxInstall, 'Mods')
      : path.join(linuxInstalls[0], 'Mods');
    managedCandidates = linuxInstalls.map((p) =>
      path.join(p, 'RimWorldLinux_Data/Managed'),
    );
    workshopCandidates = linuxInstalls.map(workshopDirFromInstall);
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
    executable: managedDir ? detectExecutable(managedDir, os) : null,
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
