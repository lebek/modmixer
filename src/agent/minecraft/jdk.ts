import { app } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { REQUIRED_JDK_MAJOR } from './versions.js';

const execFileP = promisify(execFile);

/**
 * Minecraft 1.21.x mod builds need a full JDK 21 (not just a JRE — Gradle has to
 * run javac). Everything else in the toolchain comes from the project's gradlew
 * wrapper, so JDK 21 is the *only* host prerequisite ModMixer must guarantee.
 *
 * Strategy: detect an existing JDK 21 first (the user may already have one),
 * otherwise download a Temurin 21 into userData and use it. We never touch the
 * system or require admin rights — the provisioned JDK lives entirely under the
 * app's data dir and is pointed at via JAVA_HOME for Gradle invocations.
 */

export interface JdkInfo {
  /** JAVA_HOME — the dir containing bin/java(.exe) and bin/javac. */
  home: string;
  /** Full major.minor.patch we detected, e.g. "21.0.5". */
  version: string;
  /** True when ModMixer downloaded it; false when it was already on the host. */
  provisioned: boolean;
}

function exeSuffix(): string {
  return process.platform === 'win32' ? '.exe' : '';
}

function javaBin(home: string): string {
  return path.join(home, 'bin', `java${exeSuffix()}`);
}

function javacBin(home: string): string {
  return path.join(home, 'bin', `javac${exeSuffix()}`);
}

/**
 * Run `<home>/bin/java -version` and parse the major + full version. Returns
 * null if the binary is missing, isn't a JDK (no javac), or the major doesn't
 * match. `java -version` writes to stderr, so we read both streams.
 */
async function probeJdk(home: string, requireMajor = REQUIRED_JDK_MAJOR): Promise<string | null> {
  if (!fs.existsSync(javaBin(home)) || !fs.existsSync(javacBin(home))) return null;
  try {
    const { stdout, stderr } = await execFileP(javaBin(home), ['-version']);
    const text = `${stderr}\n${stdout}`;
    // Matches: version "21.0.5"  |  openjdk 21.0.5 2024-10-15  |  21
    const m = text.match(/version\s+"?(\d+)(?:\.(\d+)\.(\d+))?/) ?? text.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    if (!m) return null;
    const major = Number(m[1]);
    if (major !== requireMajor) return null;
    return m[3] ? `${m[1]}.${m[2]}.${m[3]}` : `${m[1]}`;
  } catch {
    return null;
  }
}

/** Normalize a candidate that may be a JDK root or a macOS `.jdk` bundle. */
function normalizeHome(candidate: string): string[] {
  // macOS Temurin/Oracle bundles nest the real home under Contents/Home.
  return [candidate, path.join(candidate, 'Contents', 'Home')];
}

async function firstValidHome(candidates: string[]): Promise<JdkInfo | null> {
  const seen = new Set<string>();
  for (const c of candidates) {
    for (const home of normalizeHome(c)) {
      if (seen.has(home)) continue;
      seen.add(home);
      const version = await probeJdk(home);
      if (version) return { home, version, provisioned: false };
    }
  }
  return null;
}

/**
 * macOS: `/usr/libexec/java_home -v 21 -F` prints the Contents/Home path for an
 * installed JDK 21 and exits non-zero (the -F flag) when none is present.
 */
async function macJavaHome(): Promise<string | null> {
  try {
    const { stdout } = await execFileP('/usr/libexec/java_home', [
      '-v',
      String(REQUIRED_JDK_MAJOR),
      '-F',
    ]);
    const home = stdout.trim();
    return home.length > 0 ? home : null;
  } catch {
    return null;
  }
}

/** Probe the standard per-vendor install roots for a JDK 21 directory. */
function platformInstallCandidates(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return globJdk('/Library/Java/JavaVirtualMachines', '21');
  }
  if (process.platform === 'win32') {
    const roots = [
      'C:/Program Files/Eclipse Adoptium',
      'C:/Program Files/Microsoft',
      'C:/Program Files/Java',
      'C:/Program Files/Zulu',
      'C:/Program Files/Amazon Corretto',
      'C:/Program Files/BellSoft',
    ];
    return roots.flatMap((r) => globJdk(r, '21'));
  }
  // linux
  return [
    ...globJdk('/usr/lib/jvm', '21'),
    ...globJdk(path.join(home, '.sdkman/candidates/java'), '21'),
  ];
}

/** Cheap directory glob: entries under `root` whose name contains `needle`. */
function globJdk(root: string, needle: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.includes(needle))
      .map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

/** Find an already-installed, valid JDK 21 on the host, or null. */
export async function findSystemJdk21(): Promise<JdkInfo | null> {
  // 1. JAVA_HOME, if it points at a JDK 21.
  if (process.env.JAVA_HOME) {
    const fromEnv = await firstValidHome([process.env.JAVA_HOME]);
    if (fromEnv) return fromEnv;
  }
  // 2. macOS resolver.
  if (process.platform === 'darwin') {
    const mac = await macJavaHome();
    if (mac) {
      const valid = await firstValidHome([mac]);
      if (valid) return valid;
    }
  }
  // 3. Per-vendor install dirs.
  return firstValidHome(platformInstallCandidates());
}

/** Where a ModMixer-provisioned JDK lives. */
function provisionRoot(): string {
  return path.join(app.getPath('userData'), 'toolchain', 'jdk-21');
}

function adoptiumOs(): 'mac' | 'windows' | 'linux' {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

function adoptiumArch(): 'x64' | 'aarch64' {
  return process.arch === 'arm64' ? 'aarch64' : 'x64';
}

/**
 * Adoptium "latest binary" redirect endpoint. 302-redirects to the GitHub
 * release asset (.zip on Windows, .tar.gz elsewhere). fetch follows redirects.
 */
function adoptiumUrl(): string {
  return (
    `https://api.adoptium.net/v3/binary/latest/${REQUIRED_JDK_MAJOR}/ga/` +
    `${adoptiumOs()}/${adoptiumArch()}/jdk/hotspot/normal/eclipse`
  );
}

async function extractArchive(archive: string, destDir: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  if (process.platform === 'win32') {
    // bsdtar ships in Windows 10+ and handles .zip via -xf.
    await execFileP('tar', ['-xf', archive, '-C', destDir]);
  } else {
    await execFileP('tar', ['-xzf', archive, '-C', destDir]);
  }
}

/** After extraction, find the dir whose bin/ holds a working javac. */
async function findExtractedHome(destDir: string): Promise<string | null> {
  const entries = await fsp.readdir(destDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(destDir, e.name));
  const valid = await firstValidHome([...dirs, destDir]);
  return valid?.home ?? null;
}

export interface ProvisionProgress {
  phase: 'download' | 'extract' | 'verify';
  message: string;
}

/**
 * Download + extract a Temurin 21 JDK into userData. Idempotent: if a previously
 * provisioned JDK is already valid, returns it without re-downloading.
 */
export async function provisionTemurin21(
  onProgress?: (p: ProvisionProgress) => void,
): Promise<JdkInfo> {
  const root = provisionRoot();
  // Reuse a prior provision if still valid.
  if (fs.existsSync(root)) {
    const existing = await findExtractedHome(root);
    if (existing) {
      const version = await probeJdk(existing);
      if (version) return { home: existing, version, provisioned: true };
    }
    // Stale/partial — clear and re-provision.
    await fsp.rm(root, { recursive: true, force: true });
  }
  await fsp.mkdir(root, { recursive: true });

  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
  const archive = path.join(root, `temurin-21.${ext}`);
  onProgress?.({ phase: 'download', message: 'Downloading Java 21 (Temurin)…' });
  const res = await fetch(adoptiumUrl());
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download JDK 21 (HTTP ${res.status}) from Adoptium`);
  }
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(archive));

  onProgress?.({ phase: 'extract', message: 'Extracting Java 21…' });
  const extractDir = path.join(root, 'unpacked');
  await extractArchive(archive, extractDir);
  await fsp.rm(archive, { force: true });

  onProgress?.({ phase: 'verify', message: 'Verifying Java 21…' });
  const home = await findExtractedHome(extractDir);
  if (!home) throw new Error('Provisioned JDK 21 is missing a usable java/javac.');
  const version = await probeJdk(home);
  if (!version) throw new Error('Provisioned JDK 21 failed verification.');
  return { home, version, provisioned: true };
}

let cached: JdkInfo | null = null;

/**
 * The entry point build/index code calls: return a usable JDK 21 home, detecting
 * an existing one or provisioning Temurin. Cached for the process lifetime.
 */
export async function ensureJdk21(
  onProgress?: (p: ProvisionProgress) => void,
): Promise<JdkInfo> {
  if (cached && fs.existsSync(javacBin(cached.home))) return cached;
  const system = await findSystemJdk21();
  cached = system ?? (await provisionTemurin21(onProgress));
  return cached;
}

/** Environment overlay (JAVA_HOME + PATH) to run Gradle under the given JDK. */
export function jdkEnv(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const binDir = path.join(home, 'bin');
  const sep = process.platform === 'win32' ? ';' : ':';
  return {
    ...base,
    JAVA_HOME: home,
    PATH: `${binDir}${sep}${base.PATH ?? ''}`,
  };
}
