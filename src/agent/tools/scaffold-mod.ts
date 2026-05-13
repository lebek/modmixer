import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { detectRimWorldPaths, detectGameVersionMajorMinorSync } from '../paths.js';
import {
  getWorkspacePaths,
  mintWorkspaceFolderId,
  parseAbout,
} from '../workspace.js';
import { track } from '../telemetry.js';
import type { ConversationScope } from '../conversations.js';

const Params = Type.Object({
  name: Type.String({
    description:
      "Mod display name. Used as the folder name (when creating a new mod) and shown in RimWorld's mod list.",
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
  folder: Type.Optional(
    Type.String({
      description:
        "Existing workspace folder to scaffold into. Almost never needed — when the active conversation is bound to a mod (including the untitled placeholder from \"+ new mod\"), scaffold_mod auto-operates on that folder. Only set this to scaffold a *different* mod's folder than the active scope.",
    }),
  ),
});

export interface ScaffoldModDetails {
  modPath: string;
  folder: string;
  files: string[];
  csharp: boolean;
}

/**
 * Build scaffold_mod with access to the active conversation's scope. When the
 * scope is mod-pointing-at-an-untitled-placeholder (the renderer's "+ new mod"
 * pre-creates one), an explicit `folder` param is unnecessary — we redirect
 * the call to operate on that folder so the agent can't accidentally orphan
 * the placeholder by inventing a sibling folder.
 */
export function createScaffoldModTool(
  getActiveScope: () => ConversationScope | null,
): AgentTool<typeof Params, ScaffoldModDetails> {
  return {
    name: 'scaffold_mod',
    label: 'Scaffold mod',
    description:
      "Set up a RimWorld mod's About.xml, README, and standard subfolders (About/, Defs/, Patches/, Source/, Textures/). Pass withCSharp=true to also generate a buildable .csproj + Mod.cs. The mod folder itself is an opaque internal id — when the active conversation is already bound to a mod (including the placeholder from \"+ new mod\"), scaffold_mod operates on that folder. Otherwise it mints a fresh folder id; do NOT try to control the folder name via `name`. The mod is NOT yet active in the game — run_test_cycle handles sync + enable + launch when you're ready to test.",
    parameters: Params,
  async execute(_id, params): Promise<AgentToolResult<ScaffoldModDetails>> {
    const { workspaceDir } = getWorkspacePaths();
    const { managedDir } = detectRimWorldPaths();

    const scope = getActiveScope();
    const placeholderFolder = activeUntitledPlaceholderFolder(scope, workspaceDir);
    // Refuse if the active conversation already owns a fully-scaffolded mod
    // and the caller didn't pass an explicit folder. Otherwise the next branch
    // mints a sibling folder id and orphans the existing mod — which is what
    // a model in a recovery loop will typically do after an unrelated tool
    // error (observed in 2026-05-06 Inside-zone session: a failed `edit` led
    // to three back-to-back scaffold_mod calls, each producing a fresh empty
    // mod folder). Modify-in-place via update_schematic / set_mod_metadata /
    // write is what's wanted here.
    if (!params.folder && !placeholderFolder && scope?.type === 'mod') {
      const existing = readScopeAbout(scope.modFolder, workspaceDir);
      const label = existing?.name ?? scope.modFolder;
      const pkg = existing?.packageId ? `, packageId="${existing.packageId}"` : '';
      throw new Error(
        `This conversation is already attached to mod "${label}" (folder="${scope.modFolder}"${pkg}). scaffold_mod would create a sibling folder and orphan the existing mod. To modify it, use update_schematic / set_mod_metadata or write the files directly. To intentionally re-scaffold this mod's standard files, pass folder="${scope.modFolder}". To create a different mod, start a new conversation.`,
      );
    }

    const folderName =
      params.folder ??
      placeholderFolder ??
      mintWorkspaceFolderId(workspaceDir);

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
    // Don't clobber an existing README on in-place scaffolds — the user (or a
    // previous turn) may already have written one.
    const readmePath = path.join(modPath, 'README.md');
    try {
      await fs.access(readmePath);
    } catch {
      await write(
        readmePath,
        `# ${params.name}\n\n${params.description}\n`,
        written,
      );
    }

    if (params.withCSharp) {
      // Derive the assembly / namespace from the display name, not the
      // folder — the folder is now an opaque hex id, which would produce
      // gibberish like `Mod3a2f1b4c` everywhere RimWorld surfaces the
      // assembly (Player.log, Harmony stack traces, def parse errors).
      const ident = identifierFor(params.name);
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
      '\n\nThe mod is in the workspace but not yet active in RimWorld. run_test_cycle (folder="' +
      folderName +
      '") will sync, enable, and launch it when you\'re ready to test.';
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
}

/**
 * Returns the active scope's mod folder name iff scope is mod and the mod's
 * About.xml has an empty packageId — i.e. it's still in the placeholder state
 * the renderer drops in when "+ new mod" is clicked. Used to redirect a bare
 * scaffold_mod call to operate in-place rather than spawning a duplicate folder.
 */
function activeUntitledPlaceholderFolder(
  scope: ConversationScope | null,
  workspaceDir: string,
): string | null {
  if (!scope || scope.type !== 'mod') return null;
  const aboutPath = path.join(
    workspaceDir,
    scope.modFolder,
    'About',
    'About.xml',
  );
  try {
    const xml = fsSync.readFileSync(aboutPath, 'utf8');
    if (parseAbout(xml).packageId.trim() === '') return scope.modFolder;
  } catch {
    // No About.xml or unreadable — treat as not-a-placeholder; let the caller
    // fall through to the from-name folder behavior.
  }
  return null;
}

/** Best-effort read of an existing mod's About.xml for use in error messages. */
function readScopeAbout(
  modFolder: string,
  workspaceDir: string,
): { name: string; packageId: string } | null {
  try {
    const xml = fsSync.readFileSync(
      path.join(workspaceDir, modFolder, 'About', 'About.xml'),
      'utf8',
    );
    const parsed = parseAbout(xml);
    return { name: parsed.name, packageId: parsed.packageId };
  } catch {
    return null;
  }
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
