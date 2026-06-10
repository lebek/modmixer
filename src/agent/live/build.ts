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
import { DOTNET_NOT_FOUND_MESSAGE, resolveDotnet } from '../dotnet.js';
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

function runDotnet(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ exitCode: number; output: string }> {
  const dotnet = resolveDotnet();
  if (!dotnet) {
    return Promise.resolve({ exitCode: -1, output: DOTNET_NOT_FOUND_MESSAGE });
  }
  return new Promise((resolve) => {
    const proc = spawn(dotnet, args, { cwd });
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
export async function buildHotAssembly(
  modFolder: string,
  signal?: AbortSignal,
): Promise<LiveBuildResult> {
  const { workspaceDir } = getWorkspacePaths();
  const modDir = path.join(workspaceDir, modFolder);
  const sourceDir = path.join(modDir, 'Source');
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
}

/**
 * Compile a one-shot LiveAction snippet in the scratch project under
 * `<mod>/.live/scratch/`. The .csproj is written once per session (its
 * HintPaths are resolved at creation time) and the snippet is rewritten on
 * every call.
 */
export async function buildActionAssembly(
  modFolder: string,
  code: string,
  signal?: AbortSignal,
): Promise<LiveBuildResult> {
  const { workspaceDir } = getWorkspacePaths();
  const scratchDir = path.join(workspaceDir, modFolder, '.live', 'scratch');
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
  </ItemGroup>
</Project>
`;
}
