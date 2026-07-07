/**
 * RimWorld C# scaffold: the buildable Source/ project (ModSource.csproj +
 * Mod.cs) that every mod folder gets at creation time. Laid down by the
 * adapter's createPlaceholder so a mod is always a compilable project — the
 * agent just writes C# into Source/ when it needs runtime code, with no
 * separate "enable C#" step.
 *
 * The assembly/namespace name is the STABLE literal "ModSource", never derived
 * from the (mutable) display name — so renaming the mod never has to rename the
 * assembly, rewrite namespaces, or touch this project. The startup log line
 * reads the mod's real name from the ContentPack at runtime, so it stays
 * correct without baking the display name into the file.
 */
import path from 'node:path';
import fs from 'node:fs/promises';

/** Stable assembly + root namespace for every mod's C# project. */
const ASSEMBLY = 'ModSource';

/**
 * Write Source/ModSource.csproj + Source/Mod.cs into `modDir`, wired to the
 * RimWorld install's Managed/ dir. Idempotent-ish: never clobbers an existing
 * Mod.cs (the agent or a previous run may have written real code there), but
 * always (re-)stamps the csproj so HintPaths track the current install.
 */
export async function layRimworldCSharpScaffold(
  modDir: string,
  opts: { managedDir: string | null },
): Promise<void> {
  const sourceDir = path.join(modDir, 'Source');
  await fs.mkdir(sourceDir, { recursive: true });

  const csproj = renderCsproj({ assemblyName: ASSEMBLY, managedDir: opts.managedDir });
  await fs.writeFile(path.join(sourceDir, `${ASSEMBLY}.csproj`), csproj, 'utf8');

  const modCsPath = path.join(sourceDir, 'Mod.cs');
  try {
    await fs.access(modCsPath);
  } catch {
    await fs.writeFile(modCsPath, renderModCs(), 'utf8');
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

function renderModCs(): string {
  return `using Verse;

namespace ${ASSEMBLY}
{
    public class ${ASSEMBLY}Mod : Mod
    {
        public ${ASSEMBLY}Mod(ModContentPack content) : base(content)
        {
            Log.Message($"[{content.Name}] loaded.");
        }
    }
}
`;
}
