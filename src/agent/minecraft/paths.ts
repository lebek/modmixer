import { homedir, platform } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Locating Minecraft on disk. Two distinct needs:
 *  1. The agent's automated test loop launches the modded client via the
 *     project's `./gradlew runClient` — it needs NO launcher and NO instance
 *     here. (See minecraft/gradle.ts.)
 *  2. The user's manual play / publish: ModMixer drops the built mod jar into
 *     a launcher *instance's* mods/ folder. That's what this module discovers.
 *
 * Most modded users run per-instance dirs under a launcher (Modrinth App, Prism,
 * CurseForge) rather than the shared .minecraft, so we enumerate instances and
 * let the user pick which to deploy to.
 */

export type Launcher = 'vanilla' | 'modrinth' | 'prism' | 'curseforge';

export interface MinecraftInstance {
  launcher: Launcher;
  /** Display name (instance/profile folder name, or "Default" for vanilla). */
  name: string;
  /** The .minecraft game directory for this instance. */
  gameDir: string;
  /** Where mod jars go: <gameDir>/mods. May not exist until first launch. */
  modsDir: string;
}

function appData(): string {
  return process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming');
}

/** Vanilla `.minecraft` default per platform (note: no leading dot on macOS). */
export function defaultMinecraftDir(): string {
  const os = platform();
  if (os === 'win32') return path.join(appData(), '.minecraft');
  if (os === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'minecraft');
  return path.join(homedir(), '.minecraft');
}

/** Per-launcher data roots to probe for instances. */
function launcherDataRoots(): Record<Exclude<Launcher, 'vanilla'>, string[]> {
  const os = platform();
  const home = homedir();
  if (os === 'win32') {
    return {
      modrinth: [path.join(appData(), 'ModrinthApp')],
      prism: [
        path.join(appData(), 'PrismLauncher'),
        path.join(home, 'AppData', 'Local', 'Programs', 'PrismLauncher'),
      ],
      curseforge: [
        path.join(home, 'curseforge', 'minecraft'),
        path.join(home, 'Documents', 'Curse', 'Minecraft'),
      ],
    };
  }
  if (os === 'darwin') {
    return {
      modrinth: [path.join(home, 'Library', 'Application Support', 'ModrinthApp')],
      prism: [path.join(home, 'Library', 'Application Support', 'PrismLauncher')],
      curseforge: [path.join(home, 'Documents', 'curseforge', 'minecraft')],
    };
  }
  return {
    modrinth: [
      path.join(home, '.local', 'share', 'ModrinthApp'),
      path.join(home, '.config', 'ModrinthApp'),
    ],
    prism: [
      path.join(home, '.local', 'share', 'PrismLauncher'),
      path.join(home, '.local', 'share', 'prismlauncher'),
    ],
    curseforge: [path.join(home, '.config', 'curseforge')],
  };
}

function dirsUnder(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

/** Pick the first existing of several candidate game dirs inside an instance. */
function resolveGameDir(instanceDir: string, candidates: string[]): string | null {
  for (const c of candidates) {
    const full = path.join(instanceDir, c);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function instance(launcher: Launcher, name: string, gameDir: string): MinecraftInstance {
  return { launcher, name, gameDir, modsDir: path.join(gameDir, 'mods') };
}

/**
 * Enumerate Minecraft instances across the supported launchers. Best-effort:
 * missing launchers/instances are skipped silently. The Modrinth App is the
 * recommended beta target and is discovered most reliably.
 */
export function detectMinecraftInstances(): MinecraftInstance[] {
  const out: MinecraftInstance[] = [];

  // Vanilla shared .minecraft.
  const vanilla = defaultMinecraftDir();
  if (fs.existsSync(vanilla)) out.push(instance('vanilla', 'Default (.minecraft)', vanilla));

  const roots = launcherDataRoots();

  // Modrinth App: <root>/profiles/<name>/ is the game dir (mods/ lives directly under it).
  for (const root of roots.modrinth) {
    for (const dir of dirsUnder(path.join(root, 'profiles'))) {
      out.push(instance('modrinth', path.basename(dir), dir));
    }
  }

  // Prism: <root>/instances/<name>/{.minecraft,minecraft}/.
  for (const root of roots.prism) {
    for (const dir of dirsUnder(path.join(root, 'instances'))) {
      const gameDir = resolveGameDir(dir, ['.minecraft', 'minecraft']);
      if (gameDir) out.push(instance('prism', path.basename(dir), gameDir));
    }
  }

  // CurseForge: <root>/Instances/<name>/ is the game dir.
  for (const root of roots.curseforge) {
    for (const dir of dirsUnder(path.join(root, 'Instances'))) {
      out.push(instance('curseforge', path.basename(dir), dir));
    }
  }

  return out;
}

/** True when a JDK-21-buildable Minecraft is plausibly present (any instance or vanilla dir). */
export function hasMinecraftInstall(): boolean {
  return fs.existsSync(defaultMinecraftDir()) || detectMinecraftInstances().length > 0;
}
