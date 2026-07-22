/**
 * RimWorld C# scaffold: the buildable Source/ project (<Assembly>.csproj +
 * Mod.cs) laid down on demand by the add_csharp tool when a mod needs runtime
 * code. Mods are XML-only by default (createPlaceholder makes an empty Source/,
 * not this project), so the agent picks up a C# project only when it decides
 * it needs one, then writes .cs files into Source/.
 *
 * The assembly/namespace name is chosen ONCE, up front, by the caller (see
 * deriveAssemblyName in ./assembly-names) — derived from the mod's display
 * name and made unique across the workspace. It must be unique: RimWorld (Mono)
 * loads at most one assembly per identity and silently skips duplicates, so two
 * mods sharing a name means one never loads, with no error. It's fixed at
 * scaffold time (not re-derived on rename) so a later rename never has to
 * rewrite the assembly, the namespace, or the persisted `Class="…"` references;
 * the startup log reads the mod's real name from the ContentPack at runtime.
 */
import path from 'node:path';
import fs from 'node:fs/promises';

/**
 * Write Source/<assemblyName>.csproj + Source/Mod.cs into `modDir`, wired to
 * the RimWorld install's Managed/ dir. Idempotent-ish: never clobbers an
 * existing Mod.cs (the agent or a previous run may have written real code
 * there), but always (re-)stamps the csproj so HintPaths track the current
 * install. The caller derives a unique `assemblyName` (add_csharp guards on an
 * existing csproj, so this only runs for a mod's first C# project).
 */
export async function layRimworldCSharpScaffold(
  modDir: string,
  opts: { managedDir: string | null; assemblyName: string },
): Promise<void> {
  const { assemblyName } = opts;
  const sourceDir = path.join(modDir, 'Source');
  await fs.mkdir(sourceDir, { recursive: true });

  const csproj = renderCsproj({ assemblyName, managedDir: opts.managedDir });
  await fs.writeFile(
    path.join(sourceDir, `${assemblyName}.csproj`),
    csproj,
    'utf8',
  );

  const modCsPath = path.join(sourceDir, 'Mod.cs');
  try {
    await fs.access(modCsPath);
  } catch {
    await fs.writeFile(modCsPath, renderModCs(assemblyName), 'utf8');
  }
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

function renderModCs(assemblyName: string): string {
  return `using Verse;

namespace ${assemblyName}
{
    public class ${assemblyName}Mod : Mod
    {
        public ${assemblyName}Mod(ModContentPack content) : base(content)
        {
            Log.Message($"[{content.Name}] loaded.");
        }
    }
}
`;
}
