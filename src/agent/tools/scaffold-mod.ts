import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import path from 'node:path';
import { getWorkspacePaths, mintWorkspaceFolderId } from '../workspace.js';
import { track } from '../telemetry.js';
import { writeModPrefs } from '../mod-prefs.js';
import { getAdapter } from '../adapters/index.js';
import type { ScaffoldModDetails } from '../adapters/types.js';
import type { ConversationScope } from '../conversations.js';
import type { GameId } from '../games/types.js';

const Params = Type.Object({
  name: Type.String({
    description:
      "Mod display name. Used as the folder name (when creating a new mod) and shown in the game's mod list.",
  }),
  packageId: Type.String({
    description:
      'RimWorld: reverse-DNS package id (lowercase, no spaces), e.g. "alebek.helloworld". Minecraft: the mod id — a short lowercase word, e.g. "coolblocks".',
  }),
  description: Type.String({
    description:
      "Short description shown in the game's mod list and on the published page. One or two sentences is fine at scaffold time; refine via set_mod_metadata later.",
  }),
  author: Type.Optional(
    Type.String({ description: 'Author name. Defaults to "Modmixer User".' }),
  ),
  rimworldVersions: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'RimWorld only. Supported versions, e.g. ["1.5","1.6"]. Defaults to the user\'s detected installed version (or "1.5"). Only set when the user explicitly wants back-compat across versions.',
    }),
  ),
  withCSharp: Type.Optional(
    Type.Boolean({
      description:
        'RimWorld only. Generate a buildable C# project (Source/<name>.csproj + Source/Mod.cs) wired to RimWorld\'s Assembly-CSharp.dll. Set true when the mod needs runtime code; XML-only mods can leave this false.',
    }),
  ),
  folder: Type.Optional(
    Type.String({
      description:
        "Existing workspace folder to scaffold into. Almost never needed — when the active conversation is bound to a mod (including the untitled placeholder from \"+ new mod\"), scaffold_mod auto-operates on that folder. Only set this to scaffold a *different* mod's folder than the active scope.",
    }),
  ),
});

/**
 * Build scaffold_mod with the active conversation's scope and game. Folder
 * resolution + the placeholder/orphan guard are conversation/session concerns
 * and stay here; the actual project layout is dispatched to the game adapter
 * (RimWorld → About.xml + subfolders; Minecraft → NeoForge gradle project).
 *
 * When the scope is mod-pointing-at-an-untitled-placeholder (the renderer's
 * "+ new mod" pre-creates one), an explicit `folder` param is unnecessary — we
 * redirect the call to that folder so the agent can't accidentally orphan the
 * placeholder by inventing a sibling folder.
 */
export function createScaffoldModTool(
  getActiveScope: () => ConversationScope | null,
  game: GameId,
): AgentTool<typeof Params, ScaffoldModDetails> {
  return {
    name: 'scaffold_mod',
    label: 'Scaffold mod',
    description: getAdapter(game).toolText.scaffold,
    parameters: Params,
    async execute(_id, params): Promise<AgentToolResult<ScaffoldModDetails>> {
      const { workspaceDir } = getWorkspacePaths();

      const scope = getActiveScope();
      const placeholderFolder = activeUntitledPlaceholderFolder(
        scope,
        workspaceDir,
        game,
      );
      // Refuse if the active conversation already owns a fully-scaffolded mod
      // and the caller didn't pass an explicit folder. Otherwise the next branch
      // mints a sibling folder id and orphans the existing mod — which is what a
      // model in a recovery loop will typically do after an unrelated tool
      // error. Modify-in-place via update_schematic / set_mod_metadata / write
      // is what's wanted here.
      if (!params.folder && !placeholderFolder && scope?.type === 'mod') {
        const existing = await readScopeIdentity(scope.modFolder, workspaceDir, game);
        const label = existing?.name ?? scope.modFolder;
        const pkg = existing?.packageId
          ? `, packageId="${existing.packageId}"`
          : '';
        throw new Error(
          `This conversation is already attached to mod "${label}" (folder="${scope.modFolder}"${pkg}). scaffold_mod would create a sibling folder and orphan the existing mod. To modify it, use update_schematic / set_mod_metadata or write the files directly. To intentionally re-scaffold this mod's standard files, pass folder="${scope.modFolder}". To create a different mod, start a new conversation.`,
        );
      }

      const folderName =
        params.folder ?? placeholderFolder ?? mintWorkspaceFolderId(workspaceDir);
      const modPath = path.join(workspaceDir, folderName);

      const result = await getAdapter(game).scaffold(modPath, {
        name: params.name,
        packageId: params.packageId,
        description: params.description,
        author: params.author ?? 'Modmixer User',
        rimworldVersions: params.rimworldVersions,
        withCSharp: params.withCSharp,
      });

      // Record the target game on the folder so the rest of the app treats it
      // correctly — matters for a freshly-minted folder from a non-mod-scoped
      // chat (a mod-scoped placeholder already has it; the write is idempotent).
      await writeModPrefs(folderName, { game });
      track({ name: 'mod_created' });
      return result;
    },
  };
}

/**
 * Returns the active scope's mod folder iff it's still the untitled placeholder
 * the renderer drops in on "+ new mod" — RimWorld: About.xml with an empty
 * packageId; Minecraft: gradle.properties with mod_id "untitledmod". Used to
 * redirect a bare scaffold_mod call to operate in-place rather than spawning a
 * duplicate folder.
 */
function activeUntitledPlaceholderFolder(
  scope: ConversationScope | null,
  workspaceDir: string,
  game: GameId,
): string | null {
  if (!scope || scope.type !== 'mod') return null;
  const modDir = path.join(workspaceDir, scope.modFolder);
  return getAdapter(game).isPlaceholderMod(modDir) ? scope.modFolder : null;
}

/** Best-effort read of an existing mod's identity for orphan-guard messages. */
async function readScopeIdentity(
  modFolder: string,
  workspaceDir: string,
  game: GameId,
): Promise<{ name: string; packageId: string } | null> {
  const modDir = path.join(workspaceDir, modFolder);
  const meta = await getAdapter(game).readModMetadata(modDir, modFolder);
  return meta ? { name: meta.name, packageId: meta.packageId } : null;
}
