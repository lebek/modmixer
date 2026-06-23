/**
 * RimWorld scaffold: About.xml + README + the standard subfolders (About/,
 * Defs/, Patches/, Source/, Textures/), optionally a buildable .csproj + Mod.cs.
 * Extracted out of tools/scaffold-mod.ts so the scaffold_mod tool dispatches to
 * getAdapter(game).scaffold() and this RimWorld-specific layout lives in the
 * rimworld/ module. Folder resolution + the placeholder/orphan guard stay in
 * the tool (they're conversation/session concerns, not game concerns).
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import {
  detectRimWorldPaths,
  detectGameVersionMajorMinorSync,
} from '../paths.js';
import type { ScaffoldModDetails, ScaffoldOptions } from '../adapters/types.js';

export async function scaffoldRimworldMod(
  modDir: string,
  opts: ScaffoldOptions,
): Promise<AgentToolResult<ScaffoldModDetails>> {
  const { managedDir } = detectRimWorldPaths();
  const folder = path.basename(modDir);
  const subdirs = ['About', 'Defs', 'Patches', 'Source', 'Textures'];

  await fs.mkdir(modDir, { recursive: true });
  await Promise.all(
    subdirs.map((d) => fs.mkdir(path.join(modDir, d), { recursive: true })),
  );

  const versions =
    opts.rimworldVersions && opts.rimworldVersions.length > 0
      ? opts.rimworldVersions
      : [detectGameVersionMajorMinorSync() ?? '1.5'];

  const aboutXml = renderAboutXml({
    name: opts.name,
    packageId: opts.packageId,
    description: opts.description,
    author: opts.author,
    versions,
  });

  const written: string[] = [];
  await write(path.join(modDir, 'About', 'About.xml'), aboutXml, written);
  // Don't clobber an existing README on in-place scaffolds — the user (or a
  // previous turn) may already have written one.
  const readmePath = path.join(modDir, 'README.md');
  try {
    await fs.access(readmePath);
  } catch {
    await write(readmePath, `# ${opts.name}\n\n${opts.description}\n`, written);
  }

  if (opts.withCSharp) {
    // Derive the assembly / namespace from the display name, not the folder —
    // the folder is an opaque hex id, which would produce gibberish like
    // `Mod3a2f1b4c` everywhere RimWorld surfaces the assembly (Player.log,
    // Harmony stack traces, def parse errors).
    const ident = identifierFor(opts.name);
    const csproj = renderCsproj({ assemblyName: ident, managedDir });
    const modCs = renderModCs({ identifier: ident, displayName: opts.name });
    await write(path.join(modDir, 'Source', `${ident}.csproj`), csproj, written);
    await write(path.join(modDir, 'Source', 'Mod.cs'), modCs, written);
  }

  const relFiles = written.map((f) => path.relative(modDir, f));
  const noteAboutInstall =
    '\n\nThe mod is in the workspace but not yet active in RimWorld. run_test_cycle (folder="' +
    folder +
    '") will sync, enable, and launch it when you\'re ready to test.';
  const noteAboutManaged =
    opts.withCSharp && !managedDir
      ? '\n\nNOTE: RimWorld install was not detected, so the .csproj has empty HintPaths. The build will fail until RimWorld is installed via Steam or you fix the HintPath manually.'
      : '';

  return {
    content: [
      {
        type: 'text',
        text: `Scaffolded mod at ${modDir}\nFiles: ${relFiles.join(', ')}${noteAboutInstall}${noteAboutManaged}`,
      },
    ],
    details: {
      modPath: modDir,
      folder,
      files: written,
      csharp: !!opts.withCSharp,
    },
  };
}

async function write(target: string, content: string, written: string[]) {
  await fs.writeFile(target, content, 'utf8');
  written.push(target);
}

function renderAboutXml(input: {
  name: string;
  packageId: string;
  description: string;
  author: string;
  versions: string[];
}): string {
  const versionList = input.versions
    .map((v) => `    <li>${escape(v)}</li>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ModMetaData>
  <name>${escape(input.name)}</name>
  <packageId>${escape(input.packageId)}</packageId>
  <author>${escape(input.author)}</author>
  <description>${escape(input.description)}</description>
  <supportedVersions>
${versionList}
  </supportedVersions>
</ModMetaData>
`;
}

function renderCsproj(input: {
  assemblyName: string;
  managedDir: string | null;
}): string {
  const hint = (dll: string) =>
    input.managedDir
      ? path.join(input.managedDir, dll).replace(/\\/g, '\\\\')
      : '';
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net472</TargetFramework>
    <AssemblyName>${input.assemblyName}</AssemblyName>
    <RootNamespace>${input.assemblyName}</RootNamespace>
    <OutputPath>..\\Assemblies\\</OutputPath>
    <AppendTargetFrameworkToOutputPath>false</AppendTargetFrameworkToOutputPath>
    <CopyLocalLockFileAssemblies>false</CopyLocalLockFileAssemblies>
    <Nullable>enable</Nullable>
    <LangVersion>latest</LangVersion>
  </PropertyGroup>
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

function renderModCs(input: { identifier: string; displayName: string }): string {
  return `using Verse;

namespace ${input.identifier}
{
    public class ${input.identifier}Mod : Mod
    {
        public ${input.identifier}Mod(ModContentPack content) : base(content)
        {
            Log.Message("[${input.displayName}] loaded.");
        }
    }
}
`;
}

function identifierFor(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]/g, '');
  if (!cleaned || /^[0-9]/.test(cleaned)) return `Mod${cleaned}`;
  return cleaned;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
