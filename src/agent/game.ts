import path from 'node:path';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { spawn, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import { detectRimWorldPaths } from './paths.js';
import { getWorkspacePaths } from './workspace.js';
import { getLogWatcher } from './log-watcher.js';

const STEAM_URL = 'steam://rungameid/294100';
const execAsync = promisify(exec);

export async function isRimWorldRunning(): Promise<boolean> {
  const os = platform();
  try {
    if (os === 'darwin' || os === 'linux') {
      // -i match case-insensitive on the program name (NOT full args), so we
      // don't false-positive on paths that happen to contain "RimWorld".
      const { stdout } = await execAsync('pgrep -i rimworld');
      return stdout.trim().length > 0;
    }
    if (os === 'win32') {
      const { stdout } = await execAsync(
        'tasklist /FI "IMAGENAME eq RimWorldWin64.exe" /NH',
      );
      return stdout.toLowerCase().includes('rimworldwin64');
    }
  } catch {
    // pgrep / tasklist exit non-zero when no match; that's "not running".
    return false;
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
      await execAsync('pkill -i rimworld');
      killed = true;
    } else if (os === 'win32') {
      await execAsync('taskkill /IM RimWorldWin64.exe /F');
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
  if (await isRimWorldRunning()) {
    throw new Error(
      'RimWorld is currently running. Edits to ModsConfig.xml are overwritten when the game quits, and a running game won\'t pick up new mods. Quit RimWorld first, then retry.',
    );
  }
  const packageId = await getModPackageId(folder);
  let xml = await fsp.readFile(modsConfig, 'utf8');
  const checkRe = new RegExp(
    `<li>\\s*${escapeRegex(packageId)}\\s*</li>`,
    'i',
  );
  if (checkRe.test(xml)) {
    return { packageId, alreadyEnabled: true, configPath: modsConfig };
  }
  const insertRe = /(\s*)<\/activeMods>/;
  if (!insertRe.test(xml)) {
    throw new Error('Could not find </activeMods> in ModsConfig.xml');
  }
  xml = xml.replace(insertRe, `$1  <li>${packageId}</li>$1</activeMods>`);
  await fsp.writeFile(modsConfig, xml);
  return { packageId, alreadyEnabled: false, configPath: modsConfig };
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
  let xml = await fsp.readFile(modsConfig, 'utf8');
  const re = new RegExp(
    `\\s*<li>\\s*${escapeRegex(packageId)}\\s*</li>`,
    'gi',
  );
  if (!re.test(xml)) {
    return { packageId, wasEnabled: false, configPath: modsConfig };
  }
  xml = xml.replace(re, '');
  await fsp.writeFile(modsConfig, xml);
  return { packageId, wasEnabled: true, configPath: modsConfig };
}

export interface LaunchResult {
  url: string;
  command: string;
  alreadyRunning: boolean;
}

export async function launchRimWorldViaSteam(): Promise<LaunchResult> {
  if (await isRimWorldRunning()) {
    return {
      url: STEAM_URL,
      command: '(skipped — RimWorld already running)',
      alreadyRunning: true,
    };
  }
  // Reset the log watcher's read position so monitor_player_log only surfaces
  // errors from THIS session, not residue from a prior run.
  getLogWatcher().resetForNewSession();
  const os = platform();
  let cmd: string;
  let args: string[];
  if (os === 'darwin') {
    cmd = 'open';
    args = [STEAM_URL];
  } else if (os === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', STEAM_URL];
  } else {
    cmd = 'xdg-open';
    args = [STEAM_URL];
  }
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  return {
    url: STEAM_URL,
    command: `${cmd} ${args.join(' ')}`,
    alreadyRunning: false,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
