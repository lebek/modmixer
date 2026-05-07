import path from 'node:path';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { spawn, exec } from 'node:child_process';
import { platform } from 'node:os';
import { detectRimWorldPaths } from './paths.js';
import { getWorkspacePaths } from './workspace.js';
import { getLogWatcher } from './log-watcher.js';
import { getRegistry } from './registry/index.js';

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
    // here is recoverable (launch_rimworld no-ops when the game is up);
    // a hang is not.
  }
  return false;
}

/**
 * Wait until `isRimWorldRunning()` reports false, polling every 250ms up to
 * `timeoutMs`. The kill signal returns immediately on every platform we
 * support, but the OS still needs a moment to reap the process — without
 * this wait, callers race `enable_mod_in_game` (which refuses to run while
 * RimWorld is up) and `launch_rimworld` (which becomes a no-op if the prior
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
 * Cold-start RimWorld by spawning the game executable directly. We bypass
 * Steam (`steam://rungameid/294100`) for two reasons:
 *   1. Steam URLs silently swallow extra args on some configs, so passing
 *      `-quicktest` and similar dev flags isn't reliable through the URL.
 *   2. Direct spawn is just simpler — one code path on every OS.
 *
 * Steam itself still has to be running for the Steamworks API to initialize
 * (RimWorld loads steam_api64.dll on startup); that's a precondition the
 * user's existing Steam session covers.
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
  // Reset the log watcher's read position so monitor_player_log only surfaces
  // errors from THIS session, not residue from a prior run.
  getLogWatcher().resetForNewSession();
  // Launch from the install dir so the engine resolves steam_api64.dll and
  // its data folders relative to the exe — same cwd Steam would use.
  const cwd = path.dirname(executable);
  spawn(executable, args, { cwd, detached: true, stdio: 'ignore' }).unref();
  return { executable, args, alreadyRunning: false };
}

