import { app } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolveDotnet } from './dotnet.js';

const execFileP = promisify(execFile);

/**
 * Just-in-time .NET SDK provisioning — the RimWorld analogue of minecraft/jdk.ts.
 * RimWorld C# mods compile with `dotnet build` (targeting net472 via the
 * Microsoft.NETFramework.ReferenceAssemblies NuGet package, restored at build
 * time), so the one host prerequisite for a C# build is a `dotnet` SDK.
 *
 * Strategy mirrors the JDK: detect a system `dotnet` first (resolveDotnet),
 * otherwise download a portable SDK into userData and run it via DOTNET_ROOT.
 * Nothing is installed system-wide and no admin is required — so the agent can
 * build C# mods with zero manual "go install .NET and relaunch" detour.
 */

/** LTS channel we provision when the host has no usable SDK. */
const DOTNET_CHANNEL = '8.0';

/** Minimum SDK major we accept from a system install (matches dotnet.ts copy). */
const MIN_DOTNET_MAJOR = 6;

export interface DotnetInfo {
  /** DOTNET_ROOT — the dir containing the `dotnet` host executable. */
  dir: string;
  /** Absolute path to the `dotnet` executable. */
  exe: string;
  /** SDK version reported by `dotnet --version`, e.g. "8.0.404". */
  version: string;
  /** True when ModMixer downloaded it; false when it was already on the host. */
  provisioned: boolean;
}

function exeSuffix(): string {
  return process.platform === 'win32' ? '.exe' : '';
}

/** Run `<dotnet> --version` and parse the SDK version; null if unusable/too old. */
async function probeDotnet(exe: string): Promise<string | null> {
  if (!fs.existsSync(exe)) return null;
  try {
    const { stdout } = await execFileP(exe, ['--version']);
    const version = stdout.trim();
    const major = Number(version.split('.')[0]);
    if (!Number.isFinite(major) || major < MIN_DOTNET_MAJOR) return null;
    return version;
  } catch {
    return null;
  }
}

/** A system `dotnet` SDK (via resolveDotnet's PATH/standard-location walk), or null. */
async function findSystemDotnet(): Promise<DotnetInfo | null> {
  const exe = resolveDotnet();
  if (!exe) return null;
  const version = await probeDotnet(exe);
  if (!version) return null;
  return { dir: path.dirname(exe), exe, version, provisioned: false };
}

/** Where a ModMixer-provisioned .NET SDK lives. */
function provisionRoot(): string {
  return path.join(app.getPath('userData'), 'toolchain', 'dotnet');
}

function provisionedExe(): string {
  return path.join(provisionRoot(), `dotnet${exeSuffix()}`);
}

function dotnetRid(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'darwin') return `osx-${arch}`;
  if (process.platform === 'win32') return `win-${arch}`;
  return `linux-${arch}`;
}

/**
 * aka.ms "latest SDK for channel" redirect — resolves to the newest GA patch of
 * the channel for this RID and follows redirects to the CDN asset.
 *
 * NOTE: the exact aka.ms path should be confirmed against a live download during
 * runtime QA (it's the one external URL here); if it 404s, the fallback is the
 * versioned builds.dotnet.microsoft.com/dotnet/Sdk/<v>/dotnet-sdk-<v>-<rid> form.
 */
function dotnetSdkUrl(): string {
  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
  return `https://aka.ms/dotnet/${DOTNET_CHANNEL}/dotnet-sdk-${dotnetRid()}.${ext}`;
}

async function extractArchive(archive: string, destDir: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  // The .NET SDK archive unpacks its contents (the `dotnet` host + sdk/, shared/,
  // host/) directly into destDir — no top-level wrapper folder, unlike the JDK.
  if (process.platform === 'win32') {
    await execFileP('tar', ['-xf', archive, '-C', destDir]);
  } else {
    await execFileP('tar', ['-xzf', archive, '-C', destDir]);
  }
}

export interface DotnetProvisionProgress {
  phase: 'download' | 'extract' | 'verify';
  message: string;
}

/**
 * Download + extract a portable .NET SDK into userData. Idempotent: a previously
 * provisioned, still-valid SDK is returned without re-downloading.
 */
async function provisionDotnetSdk(
  onProgress?: (p: DotnetProvisionProgress) => void,
): Promise<DotnetInfo> {
  const root = provisionRoot();
  const exe = provisionedExe();
  const existing = await probeDotnet(exe);
  if (existing) return { dir: root, exe, version: existing, provisioned: true };

  // Partial/stale provision — clear and start clean.
  if (fs.existsSync(root)) await fsp.rm(root, { recursive: true, force: true });
  await fsp.mkdir(root, { recursive: true });

  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
  const archive = path.join(root, `dotnet-sdk.${ext}`);
  onProgress?.({ phase: 'download', message: 'Downloading the .NET SDK…' });
  const res = await fetch(dotnetSdkUrl());
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download the .NET SDK (HTTP ${res.status}).`);
  }
  await pipeline(
    Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
    fs.createWriteStream(archive),
  );

  onProgress?.({ phase: 'extract', message: 'Extracting the .NET SDK…' });
  await extractArchive(archive, root);
  await fsp.rm(archive, { force: true });

  onProgress?.({ phase: 'verify', message: 'Verifying the .NET SDK…' });
  const version = await probeDotnet(exe);
  if (!version) throw new Error('Provisioned .NET SDK failed verification.');
  return { dir: root, exe, version, provisioned: true };
}

/**
 * A usable .NET SDK WITHOUT downloading one — a system install or an already
 * provisioned copy. For the setup requirement row (cheap probe), and as the
 * fast path in build code.
 */
export async function findExistingDotnet(): Promise<DotnetInfo | null> {
  const system = await findSystemDotnet();
  if (system) return system;
  const exe = provisionedExe();
  const version = await probeDotnet(exe);
  if (version) return { dir: provisionRoot(), exe, version, provisioned: true };
  return null;
}

let cached: DotnetInfo | null = null;

/**
 * The entry point C# build code calls: return a usable .NET SDK, detecting an
 * existing one (system or previously provisioned) or downloading one. Cached for
 * the process lifetime.
 */
export async function ensureDotnetSdk(
  onProgress?: (p: DotnetProvisionProgress) => void,
): Promise<DotnetInfo> {
  if (cached && fs.existsSync(cached.exe)) return cached;
  const existing = await findExistingDotnet();
  cached = existing ?? (await provisionDotnetSdk(onProgress));
  return cached;
}

/** Environment overlay (DOTNET_ROOT + PATH) to run a provisioned `dotnet`. */
export function dotnetEnv(
  info: DotnetInfo,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // System installs already resolve their own root; only a provisioned SDK needs
  // DOTNET_ROOT pinned so it finds its bundled host/sdk.
  if (!info.provisioned) return base;
  const sep = process.platform === 'win32' ? ';' : ':';
  return {
    ...base,
    DOTNET_ROOT: info.dir,
    PATH: `${info.dir}${sep}${base.PATH ?? ''}`,
  };
}
