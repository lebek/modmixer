import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import path from 'node:path';
import fs from 'node:fs/promises';
import { detectRimWorldPaths, detectGameVersionMajorMinorSync } from '../paths.js';
import { getWorkspacePaths } from '../workspace.js';
import { track } from '../telemetry.js';

const Params = Type.Object({
  name: Type.String({
    description:
      "Mod display name. Used as the folder name and shown in RimWorld's mod list.",
  }),
  packageId: Type.String({
    description:
      'Reverse-DNS package id, lowercase, no spaces. Example: "alebek.helloworld".',
  }),
  description: Type.String({
    description:
      "Short description shown in RimWorld's mod list and on the Steam Workshop page. One or two sentences is fine at scaffold time; refine via set_mod_metadata later.",
  }),
  author: Type.Optional(
    Type.String({ description: 'Author name. Defaults to "Modmixer User".' }),
  ),
  rimworldVersions: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Supported RimWorld versions, e.g. ["1.5","1.6"]. Defaults to the user\'s detected installed version (or "1.5" if undetectable). Only set this when the user explicitly wants back-compat across multiple versions.',
    }),
  ),
  withCSharp: Type.Optional(
    Type.Boolean({
      description:
        'Generate a buildable C# project (Source/<name>.csproj + Source/Mod.cs) wired to RimWorld\'s Assembly-CSharp.dll. Set true when the mod needs runtime code; XML-only mods can leave this false.',
    }),
  ),
});

export interface ScaffoldModDetails {
  modPath: string;
  folder: string;
  files: string[];
  csharp: boolean;
}

export const scaffoldModTool: AgentTool<typeof Params, ScaffoldModDetails> = {
  name: 'scaffold_mod',
  label: 'Scaffold mod',
  description:
    'Create a new RimWorld mod folder in the Modmixer workspace with About.xml and the standard subfolders (About/, Defs/, Patches/, Source/, Textures/). Pass withCSharp=true to also generate a buildable .csproj + Mod.cs. The mod is NOT yet active in the game — call sync_to_game to make it loadable.',
  parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<ScaffoldModDetails>> {
    const { workspaceDir } = getWorkspacePaths();
    const { managedDir } = detectRimWorldPaths();

    const folderName = params.name.replace(/[^A-Za-z0-9_ -]/g, '').trim();
    if (!folderName) throw new Error('Invalid mod name.');

    const modPath = path.join(workspaceDir, folderName);
    const subdirs = ['About', 'Defs', 'Patches', 'Source', 'Textures'];

    await fs.mkdir(modPath, { recursive: true });
    await Promise.all(
      subdirs.map((d) => fs.mkdir(path.join(modPath, d), { recursive: true })),
    );

    const author = params.author ?? 'Modmixer User';
    const versions =
      params.rimworldVersions && params.rimworldVersions.length > 0
        ? params.rimworldVersions
        : [detectGameVersionMajorMinorSync() ?? '1.5'];

    const aboutXml = renderAboutXml({
      name: params.name,
      packageId: params.packageId,
      description: params.description,
      author,
      versions,
    });

    const written: string[] = [];
    await write(path.join(modPath, 'About', 'About.xml'), aboutXml, written);
    await write(
      path.join(modPath, 'README.md'),
      `# ${params.name}\n\n${params.description}\n`,
      written,
    );

    if (params.withCSharp) {
      const ident = identifierFor(folderName);
      const csproj = renderCsproj({ assemblyName: ident, managedDir });
      const modCs = renderModCs({ identifier: ident, displayName: params.name });
      await write(
        path.join(modPath, 'Source', `${ident}.csproj`),
        csproj,
        written,
      );
      await write(path.join(modPath, 'Source', 'Mod.cs'), modCs, written);
    }

    const relFiles = written.map((f) => path.relative(modPath, f));
    const noteAboutInstall =
      '\n\nThe mod is in the workspace but not yet active in RimWorld. Call sync_to_game with folder="' +
      folderName +
      '" to make it loadable.';
    const noteAboutManaged =
      params.withCSharp && !managedDir
        ? '\n\nNOTE: RimWorld install was not detected, so the .csproj has empty HintPaths. The build will fail until RimWorld is installed via Steam or you fix the HintPath manually.'
        : '';
    track({ name: 'mod_created' });

    return {
      content: [
        {
          type: 'text',
          text: `Scaffolded mod at ${modPath}\nFiles: ${relFiles.join(', ')}${noteAboutInstall}${noteAboutManaged}`,
        },
      ],
      details: { modPath, folder: folderName, files: written, csharp: !!params.withCSharp },
    };
  },
};

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
