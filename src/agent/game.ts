import path from 'node:path';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { spawn, exec } from 'node:child_process';
import { platform } from 'node:os';
import { detectRimWorldPaths } from './paths.js';
import { getWorkspacePaths } from './workspace.js';
import { getRegistry } from './registry/index.js';

/** RimWorld's Steam application id. */
const RIMWORLD_APP_ID = '294100';

/**
 * Wrap `child_process.exec` with a hard timeout. Node kills the child on
 * expiry, so even a wedged Windows service can't pin a tool call past
 * `timeoutMs`. We hit this in the wild: `tasklist /FI` routes through WMI,
 * and a stuck Winmgmt service left the call sitting at the 5-minute RPC
 * default before erroring. Use this for every shell-out — fail fast over
 * hang silently.
 */
function execWithTimeout(
  command: string,
  timeoutMs = 10_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

export async function isRimWorldRunning(): Promise<boolean> {
  const os = platform();
  try {
    if (os === 'darwin' || os === 'linux') {
      // -i match case-insensitive on the program name (NOT full args), so we
      // don't false-positive on paths that happen to contain "RimWorld".
      const { stdout } = await execWithTimeout('pgrep -i rimworld');
      return stdout.trim().length > 0;
    }
    if (os === 'win32') {
      // Plain `tasklist /NH /FO CSV` enumerates locally via Toolhelp — no
      // WMI. The earlier `/FI "IMAGENAME eq …"` form went through Winmgmt
      // and hung the whole agent for 5 minutes when that service was sick.
      const { stdout } = await execWithTimeout('tasklist /NH /FO CSV');
      return /^"RimWorldWin64\.exe"/im.test(stdout);
    }
  } catch {
    // pgrep exits non-zero when no match; tasklist may time out via
    // execWithTimeout. Either way: assume not running. A false negative
    // here is recoverable (launchRimWorld no-ops when the game is up);
    // a hang is not.
  }
  return false;
}

/**
 * Whether the Steam client is running. RimWorld's Steamworks init connects to
 * a live local Steam session, so the direct-spawn launch path (which passes
 * -quicktest/-savedatafolder and therefore can't go through the Steam URL)
 * needs Steam up first. We match the exact client process name to avoid
 * false positives from unrelated "steam"-containing processes; a false
 * negative is harmless — re-opening Steam when it's already up just focuses it.
 */
export async function isSteamRunning(): Promise<boolean> {
  const os = platform();
  try {
    if (os === 'darwin') {
      const { stdout } = await execWithTimeout('pgrep -x steam_osx');
      return stdout.trim().length > 0;
    }
    if (os === 'linux') {
      const { stdout } = await execWithTimeout('pgrep -x steam');
      return stdout.trim().length > 0;
    }
    if (os === 'win32') {
      const { stdout } = await execWithTimeout('tasklist /NH /FO CSV');
      return /^"steam\.exe"/im.test(stdout);
    }
  } catch {
    // pgrep exits non-zero when no match; tasklist may time out. Treat as
    // not running — see the false-negative note above.
  }
  return false;
}

/**
 * The shell command that hands a URL to the OS, per platform. We use this to
 * drive Steam through its `steam://` protocol handler — opening any steam://
 * URL cold-starts the Steam client if it isn't already running.
 */
function openUrlCommand(url: string): { file: string; args: string[] } {
  switch (platform()) {
    case 'darwin':
      return { file: 'open', args: [url] };
    case 'win32':
      // `start` is a cmd builtin; the empty "" is its (ignored) window title,
      // required so a quoted URL isn't mistaken for the title.
      return { file: 'cmd', args: ['/c', 'start', '', url] };
    default:
      return { file: 'xdg-open', args: [url] };
  }
}

/**
 * Make sure the Steam client is running, starting it (via its URL handler) and
 * waiting up to `timeoutMs` for the process to appear if it isn't. Best-effort:
 * returns true once Steam is up, false on timeout. Callers proceed regardless —
 * a missed start just falls back to RimWorld's own "could not initialize Steam
 * API" path, which is no worse than before.
 */
async function ensureSteamRunning(timeoutMs = 30_000): Promise<boolean> {
  if (await isSteamRunning()) return true;
  const { file, args } = openUrlCommand('steam://open/main');
  spawn(file, args, { detached: true, stdio: 'ignore' }).unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isSteamRunning()) {
      // Give the client a moment past process-start to bring its API up before
      // RimWorld calls SteamAPI_Init against it.
      await new Promise((r) => setTimeout(r, 2_000));
      return true;
    }
  }
  return false;
}

/**
 * Wait until `isRimWorldRunning()` reports false, polling every 250ms up to
 * `timeoutMs`. The kill signal returns immediately on every platform we
 * support, but the OS still needs a moment to reap the process — without
 * this wait, callers race ModsConfig mutations (which refuse to run while
 * RimWorld is up) and `launchRimWorld` (which becomes a no-op if the prior
 * process is still alive). Returns true when the process is gone, false on
 * timeout.
 */
async function waitForRimWorldExit(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isRimWorldRunning())) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return !(await isRimWorldRunning());
}

export interface QuitResult {
  killed: boolean;
  /** True if the process was confirmed gone within the wait window. */
  exited: boolean;
}

export async function quitRimWorld(
  waitTimeoutMs = 10_000,
): Promise<QuitResult> {
  const os = platform();
  let killed = false;
  try {
    if (os === 'darwin' || os === 'linux') {
      await execWithTimeout('pkill -i rimworld');
      killed = true;
    } else if (os === 'win32') {
      await execWithTimeout('taskkill /IM RimWorldWin64.exe /F');
      killed = true;
    }
  } catch {
    killed = false;
  }
  if (!killed) return { killed: false, exited: false };
  const exited = await waitForRimWorldExit(waitTimeoutMs);
  return { killed, exited };
}

export async function getModPackageId(folder: string): Promise<string> {
  const { workspaceDir } = getWorkspacePaths();
  const aboutPath = path.join(workspaceDir, folder, 'About', 'About.xml');
  if (!fs.existsSync(aboutPath)) {
    throw new Error(`About.xml not found at ${aboutPath}`);
  }
  const xml = await fsp.readFile(aboutPath, 'utf8');
  const m = xml.match(/<packageId>([\s\S]*?)<\/packageId>/);
  const id = (m?.[1] ?? '').trim().toLowerCase();
  if (!id) throw new Error('packageId not found in About.xml');
  return id;
}

export interface EnableResult {
  packageId: string;
  alreadyEnabled: boolean;
  configPath: string;
}

export async function enableModInGame(folder: string): Promise<EnableResult> {
  const { modsConfig } = detectRimWorldPaths();
  if (!modsConfig) {
    throw new Error(
      'ModsConfig.xml not found. Launch RimWorld at least once first so it can create the file.',
    );
  }
  // Registry's writer enforces "RimWorld must be closed" + atomic write +
  // backup. We just compute the packageId and delegate.
  const packageId = await getModPackageId(folder);
  const registry = getRegistry();
  await registry.start();
  await registry.refresh();
  const result = await registry.addActiveMod(packageId);
  return {
    packageId,
    alreadyEnabled: result.alreadyEnabled,
    configPath: modsConfig,
  };
}

export interface DisableResult {
  packageId: string;
  wasEnabled: boolean;
  configPath: string;
}

export async function disableModInGame(folder: string): Promise<DisableResult> {
  const { modsConfig } = detectRimWorldPaths();
  if (!modsConfig) {
    throw new Error('ModsConfig.xml not found.');
  }
  const packageId = await getModPackageId(folder);
  const registry = getRegistry();
  await registry.start();
  await registry.refresh();
  const result = await registry.removeActiveMod(packageId);
  return {
    packageId,
    wasEnabled: result.wasEnabled,
    configPath: modsConfig,
  };
}

export interface LaunchOptions {
  /**
   * Extra command-line arguments to pass to the RimWorld executable. The
   * canonical use is `['-quicktest']`, which makes the engine bypass the
   * main menu and drop the user straight into a generated map (handy for
   * testing a mod without grinding through colony setup).
   */
  args?: string[];
  /**
   * When set, prepends `-savedatafolder=<path>` so RimWorld relocates its
   * entire LocalLow tree (Config/ModsConfig.xml, Prefs.xml, saves, scenarios)
   * to this dir for the session. Used by the isolated-test launch path so
   * the user's real mod list is never touched even on a crash.
   */
  savedataFolder?: string;
}

export interface LaunchResult {
  /** Absolute path to the executable we spawned (or would have, if running). */
  executable: string;
  /** Args passed to the executable. */
  args: string[];
  alreadyRunning: boolean;
}

/**
 * Cold-start RimWorld. There are two launch strategies and we pick by whether
 * the caller needs command-line args:
 *
 *   - No args (the Library "Launch" button, a plain real-game test): launch
 *     through `steam://rungameid/294100`. The OS protocol handler cold-starts
 *     Steam if it's closed and runs RimWorld with full Steam context, so
 *     SteamAPI_Init succeeds even for a user who never opened Steam first. This
 *     is what RimWorld's own SteamAPI_RestartAppIfNecessary tries to do, but
 *     driven from here so it's reliable on macOS (where that auto-relaunch is
 *     flaky — the symptom was a tester's "could not initialize Steam API").
 *
 *   - With args (isolated test: -savedatafolder/-quicktest): the Steam URL
 *     can't carry args, so we spawn the binary directly. A direct spawn only
 *     works if (a) Steam is already running — we have no auto-relaunch fallback
 *     here, so we start it and wait — and (b) RimWorld skips its own
 *     relaunch-through-Steam, which would drop our args. Setting
 *     SteamAppId/SteamGameId (exactly what Steam sets when it launches a game)
 *     makes SteamAPI_RestartAppIfNecessary return false so the args survive and
 *     lets SteamAPI_Init resolve the app id regardless of the working dir.
 */
export async function launchRimWorld(
  opts: LaunchOptions = {},
): Promise<LaunchResult> {
  const userArgs = opts.args ?? [];
  const args = opts.savedataFolder
    ? [`-savedatafolder=${opts.savedataFolder}`, ...userArgs]
    : userArgs;
  const { executable } = detectRimWorldPaths();
  if (!executable) {
    throw new Error(
      'RimWorld executable not found. Check the install path in app settings.',
    );
  }
  if (await isRimWorldRunning()) {
    return { executable, args, alreadyRunning: true };
  }

  if (args.length === 0) {
    const url = `steam://rungameid/${RIMWORLD_APP_ID}`;
    const { file, args: openArgs } = openUrlCommand(url);
    spawn(file, openArgs, { detached: true, stdio: 'ignore' }).unref();
    return { executable, args, alreadyRunning: false };
  }

  await ensureSteamRunning();
  // Launch from the install dir so the engine resolves steam_api64.dll and
  // its data folders relative to the exe — same cwd Steam would use.
  const cwd = path.dirname(executable);
  spawn(executable, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, SteamAppId: RIMWORLD_APP_ID, SteamGameId: RIMWORLD_APP_ID },
  }).unref();
  return { executable, args, alreadyRunning: false };
}

