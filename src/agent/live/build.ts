// dotnet build plumbing for live sessions.
//
// Two build flavors, both landing under `<mod>/.live/` (excluded from
// snapshots and never scanned by RimWorld, which only loads Assemblies/):
//
//   - hot builds: the whole session mod compiled to a per-iteration,
//     uniquely-named assembly (`<Ident>Hot<stamp>`). Unique names matter
//     because Mono can never unload an assembly — each apply_live loads a
//     fresh one and the Live mod re-points Harmony at it; a reused name
//     would just be a second copy with confusing identity.
//   - scratch builds: a one-shot `LiveAction.Run()` snippet compiled in an
//     isolated throwaway project so one-shots never touch (or dirty) the
//     session mod's own Source/.
//
// Debug configuration on purpose: optimizations off keeps the IL
// inline-resistant and the exception stacks readable — both more valuable
// in a live session than codegen quality.

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { findExistingDotnet, dotnetEnv } from '../dotnet-provision.js';
import { detectRimWorldPaths } from '../paths.js';
import { getWorkspacePaths } from '../workspace.js';

export interface LiveBuildResult {
  ok: boolean;
  /** Absolute path to the built DLL; set only when ok. */
  dllPath: string | null;
  /** Assembly name used for this build (unique per iteration). */
  assemblyName: string;
  /** Full compiler output (stdout + stderr) for the agent to read. */
  output: string;
}

/** Short, strictly-increasing, filename-safe uniquifier. */
function stamp(): string {
  return Date.now().toString(36);
}

async function runDotnet(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ exitCode: number; output: string }> {
  // Use the SDK setup provisioned — don't download mid-build. The hot-edit loop
  // surfaces a clear, actionable line if it isn't there yet.
  const dotnet = await findExistingDotnet();
  if (!dotnet) {
    return {
      exitCode: -1,
      output:
        'The .NET SDK is not set up yet. Finish RimWorld setup in Settings → Games ' +
        '(it provisions .NET), then retry.',
    };
  }
  return new Promise((resolve) => {
    const proc = spawn(dotnet.exe, args, { cwd, env: dotnetEnv(dotnet) });
    let output = '';
    proc.stdout?.on('data', (d: Buffer) => {
      output += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      output += d.toString();
    });
    const onAbort = () => proc.kill();
    signal?.addEventListener('abort', onAbort);
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code ?? -1, output });
    });
    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: -1,
        output: output + (err instanceof Error ? err.message : String(err)),
      });
    });
  });
}

/**
 * Per-project-directory build serializer. MSBuild has no isolation between
 * two concurrent builds of the same project (shared obj/, Action.cs being
 * rewritten mid-compile), and prewarmLiveBuilds can now overlap a
 * user-triggered apply_live / game_action. A real build that lands mid-warm
 * just queues behind it — no worse than the cold start it replaces.
 */
const buildChains = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = buildChains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  buildChains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** First .csproj under `<mod>/Source`, or null. */
function findCsproj(sourceDir: string): string | null {
  try {
    const entries = fs.readdirSync(sourceDir);
    const csproj = entries.find((e) => e.endsWith('.csproj'));
    return csproj ? path.join(sourceDir, csproj) : null;
  } catch {
    return null;
  }
}

/**
 * Compile the whole session mod into a fresh hot assembly under
 * `<mod>/.live/hot/`. The unique AssemblyName is passed on the CLI so the
 * .csproj on disk stays publish-shaped (a normal `dotnet build` still
 * produces the normal Assemblies/<Ident>.dll).
 */
export function buildHotAssembly(
  modFolder: string,
  signal?: AbortSignal,
): Promise<LiveBuildResult> {
  const { workspaceDir } = getWorkspacePaths();
  const modDir = path.join(workspaceDir, modFolder);
  const sourceDir = path.join(modDir, 'Source');
  return serialized(sourceDir, async () => {
    const csproj = findCsproj(sourceDir);
    if (!csproj) {
      return {
        ok: false,
        dllPath: null,
        assemblyName: '',
        output: `No .csproj found in ${sourceDir} — the session mod has no C# project to hot-build.`,
      };
    }
    const ident = path.basename(csproj, '.csproj');
    const assemblyName = `${ident}Hot${stamp()}`;
    const outDir = path.join(modDir, '.live', 'hot') + path.sep;
    const { exitCode, output } = await runDotnet(
      [
        'build',
        '--nologo',
        '-c',
        'Debug',
        `-p:AssemblyName=${assemblyName}`,
        `-p:OutputPath=${outDir}`,
        `-p:AppendTargetFrameworkToOutputPath=false`,
      ],
      sourceDir,
      signal,
    );
    const dllPath = path.join(outDir, `${assemblyName}.dll`);
    const ok = exitCode === 0 && fs.existsSync(dllPath);
    return { ok, dllPath: ok ? dllPath : null, assemblyName, output };
  });
}

/**
 * Compile a one-shot LiveAction snippet in the scratch project under
 * `<mod>/.live/scratch/`. The .csproj is written once per session (its
 * HintPaths are resolved at creation time) and the snippet is rewritten on
 * every call.
 */
export function buildActionAssembly(
  modFolder: string,
  code: string,
  signal?: AbortSignal,
): Promise<LiveBuildResult> {
  const { workspaceDir } = getWorkspacePaths();
  const scratchDir = path.join(workspaceDir, modFolder, '.live', 'scratch');
  return serialized(scratchDir, async () => {
    await fsp.mkdir(scratchDir, { recursive: true });
    const csprojPath = path.join(scratchDir, 'LiveScratch.csproj');
    if (!fs.existsSync(csprojPath)) {
      const { managedDir } = detectRimWorldPaths();
      await fsp.writeFile(csprojPath, renderScratchCsproj(managedDir), 'utf8');
    }
    await fsp.writeFile(path.join(scratchDir, 'Action.cs'), code, 'utf8');

    const assemblyName = `LiveAction${stamp()}`;
    const outDir = path.join(scratchDir, 'bin') + path.sep;
    const { exitCode, output } = await runDotnet(
      [
        'build',
        '--nologo',
        '-c',
        'Debug',
        `-p:AssemblyName=${assemblyName}`,
        `-p:OutputPath=${outDir}`,
        `-p:AppendTargetFrameworkToOutputPath=false`,
      ],
      scratchDir,
      signal,
    );
    const dllPath = path.join(outDir, `${assemblyName}.dll`);
    const ok = exitCode === 0 && fs.existsSync(dllPath);
    return { ok, dllPath: ok ? dllPath : null, assemblyName, output };
  });
}

/**
 * Run one throwaway hot build and one scratch build so the session's first
 * real apply_live / game_action doesn't pay MSBuild's cold start (NuGet
 * restore + SDK resolution — a first snippet build was observed at ~38s vs
 * ~5s warm). Called fire-and-forget at live-session launch, overlapping the
 * game boot; the per-project serializer queues any real build that arrives
 * mid-warm. Never rejects — a failed warm build just means the first real
 * build is cold again.
 */
export async function prewarmLiveBuilds(modFolder: string): Promise<void> {
  const snippet =
    'public static class LiveAction { public static string Run() { return "warm"; } }\n';
  await Promise.all([
    buildHotAssembly(modFolder).catch(() => undefined),
    buildActionAssembly(modFolder, snippet).catch(() => undefined),
  ]);
}

/**
 * Scratch project: same reference shape as scaffolded mod csprojs (direct
 * HintPaths into the RimWorld install). No Harmony reference — one-shots
 * run and return; patching belongs to the session mod via apply_live.
 */
function renderScratchCsproj(managedDir: string | null): string {
  const hint = (dll: string) =>
    managedDir ? path.join(managedDir, dll) : '';
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net472</TargetFramework>
    <AppendTargetFrameworkToOutputPath>false</AppendTargetFrameworkToOutputPath>
    <CopyLocalLockFileAssemblies>false</CopyLocalLockFileAssemblies>
    <Nullable>disable</Nullable>
    <LangVersion>latest</LangVersion>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Action.cs" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NETFramework.ReferenceAssemblies" Version="1.0.3" PrivateAssets="all" />
  </ItemGroup>
  <ItemGroup>
    <Reference Include="Assembly-CSharp">
      <HintPath>${hint('Assembly-CSharp.dll')}</HintPath>
      <Private>false</Private>
    </Reference>
    <Reference Include="UnityEngine.CoreModule">
      <HintPath>${hint('UnityEngine.CoreModule.dll')}</HintPath>
      <Private>false</Private>
    </Reference>
    <Reference Include="UnityEngine">
      <HintPath>${hint('UnityEngine.dll')}</HintPath>
      <Private>false</Private>
    </Reference>
    <Reference Include="UnityEngine.IMGUIModule">
      <HintPath>${hint('UnityEngine.IMGUIModule.dll')}</HintPath>
      <Private>false</Private>
    </Reference>
    <Reference Include="UnityEngine.TextRenderingModule">
      <HintPath>${hint('UnityEngine.TextRenderingModule.dll')}</HintPath>
      <Private>false</Private>
    </Reference>
  </ItemGroup>
</Project>
`;
}
