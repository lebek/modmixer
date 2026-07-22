import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import fs from 'node:fs';
import path from 'node:path';
import { layRimworldCSharpScaffold } from '../rimworld/scaffold.js';
import { deriveAssemblyName } from '../rimworld/assembly-names.js';
import { detectRimWorldPaths } from '../paths.js';

const Params = Type.Object({});

export interface AddCSharpDetails {
  sourceDir: string;
  created: boolean;
}

/**
 * Add a buildable C# project to the active mod on demand. `cwd` is the mod
 * folder (the session's working directory), so the project lands in this mod's
 * Source/. Only games that build C# get this tool (gated on buildTool ===
 * 'dotnet' in buildCustomTools) — a Minecraft mod is already a Gradle/Java
 * project from creation and needs no on-demand scaffold.
 *
 * Replaces the withCSharp path of the old scaffold_mod: mods are XML-only by
 * default (no dead .csproj / build overhead), and pick up a C# project only
 * when the agent decides they need runtime code.
 */
export function createAddCSharpTool(
  cwd: string,
): AgentTool<typeof Params, AddCSharpDetails> {
  return {
    name: 'add_csharp',
    label: 'Add C# project',
    description:
      "Add a buildable C# project to this mod: Source/<ModName>.csproj + a Mod.cs stub, targeting net472 and wired to RimWorld's Assembly-CSharp.dll. The assembly is named after this mod (unique across your mods) so it can't collide with another mod's DLL. Call this ONCE, before writing any .cs, when the mod needs runtime code (Harmony patches, a custom ThingComp/Verb/GameComponent, etc.). Most mods are XML-only and do NOT need it. Idempotent: a no-op if the project already exists. After it runs, write your .cs files under Source/ and build_mod compiles them.",
    parameters: Params,
    async execute(): Promise<AgentToolResult<AddCSharpDetails>> {
      const sourceDir = path.join(cwd, 'Source');
      let hasCsproj = false;
      try {
        hasCsproj = fs
          .readdirSync(sourceDir)
          .some((f) => f.toLowerCase().endsWith('.csproj'));
      } catch {
        // Source/ absent — the scaffold helper creates it below.
      }
      if (hasCsproj) {
        return {
          content: [
            {
              type: 'text',
              text: 'This mod already has a C# project in Source/. Write your .cs files there and build_mod to compile.',
            },
          ],
          details: { sourceDir, created: false },
        };
      }
      const { managedDir } = detectRimWorldPaths();
      const assemblyName = await deriveAssemblyName(cwd);
      await layRimworldCSharpScaffold(cwd, { managedDir, assemblyName });
      const note = managedDir
        ? ''
        : ' NOTE: RimWorld install was not detected, so the .csproj HintPaths are empty — the build will fail until RimWorld is installed via Steam.';
      return {
        content: [
          {
            type: 'text',
            text: `Added a C# project: Source/${assemblyName}.csproj + Source/Mod.cs (net472, assembly "${assemblyName}", wired to Assembly-CSharp). Write your code under Source/ and build_mod to compile.${note}`,
          },
        ],
        details: { sourceDir, created: true },
      };
    },
  };
}
