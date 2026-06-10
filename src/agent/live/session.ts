// "Launch Live Session" — the app-side entry point for live modding.
//
// One call does the whole flow:
//   1. scaffold a fresh session mod in the workspace (real mod, real
//      folder: anything good the user builds in-game survives the session
//      and can be kept/published later),
//   2. create a live-flagged conversation bound to it,
//   3. install the bridge (telemetry) AND the Live mod (command channel),
//   4. ship + launch RimWorld into an isolated quicktest colony,
//   5. arm bridge monitoring and bind the Live prompt channel to the
//      conversation.
//
// Clicking the button is the session's consent boundary: everything the
// agent does from here happens inside this sandbox (session mod folder +
// isolated savedata) without further prompts — which is exactly why the
// live tool set has no confirmation-gated tools (see buildCustomTools).

import path from 'node:path';
import fsp from 'node:fs/promises';
import { loadSettings } from '../settings.js';
import {
  getWorkspacePaths,
  mintWorkspaceFolderId,
} from '../workspace.js';
import { detectGameVersionMajorMinorSync, detectRimWorldPaths } from '../paths.js';
import { isRimWorldRunning, quitRimWorld } from '../game.js';
import { shipAndLaunch } from '../ship.js';
import { ensureTestSavedataPrefs } from '../test-savedata.js';
import { prepareDebugSession } from '../prefs.js';
import { getRegistry } from '../registry/index.js';
import { ensureLiveInstalled, LIVE_PACKAGE_ID } from './install.js';
import { setActiveForMod } from '../conversations.js';
import { track } from '../telemetry.js';
import { getAgentHost } from '../agent-host.js';

export interface LiveSessionLaunch {
  folder: string;
  conversationId: string;
}

/**
 * Human-facing session label, e.g. "Live Session – Jun 10". Used for both
 * the mod's display name and the conversation title.
 */
function sessionTitle(now = new Date()): string {
  const date = now.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  return `Live Session – ${date}`;
}

export async function launchLiveSession(): Promise<LiveSessionLaunch> {
  const settings = loadSettings();
  if (!settings.liveSessions) {
    throw new Error('Live sessions are disabled — enable the experiment in Settings first.');
  }

  // The Live mod must be installable before we scaffold anything — a
  // session without the in-game channel is just a confusing test cycle.
  const registry = getRegistry();
  await registry.start();
  await registry.refresh();
  const live = await ensureLiveInstalled(registry.getSnapshot());
  if (!live.available) {
    throw new Error(liveUnavailableMessage(live.skipReason));
  }

  // Same no-confirmation force-quit policy as run_test_cycle: live users
  // are about to get a fresh isolated colony; there's no save to preserve.
  if (await isRimWorldRunning()) {
    const { killed, exited } = await quitRimWorld();
    if (!killed || !exited) {
      throw new Error(
        'Could not quit the running RimWorld — close it manually and try again.',
      );
    }
  }

  const title = sessionTitle();
  const folder = await scaffoldSessionMod(title);

  const host = getAgentHost();
  const convo = await host.createConversation(
    { type: 'mod', modFolder: folder },
    title,
    { live: true },
  );
  setActiveForMod(folder, convo.id);
  // Construct the session up front so the first in-game prompt doesn't pay
  // the hydration latency on top of the model latency.
  await host.openSession(convo.id);

  // Dev-mode prefs in the isolated savedata (palette stays closed — the
  // Live window is the session's control surface, not debug actions).
  const seeded = await ensureTestSavedataPrefs();
  await prepareDebugSession({
    autoOpenPalette: false,
    prefsPath: seeded ?? undefined,
  });

  await shipAndLaunch({
    folder,
    quicktest: true,
    isolated: true,
    extraInfraMods: [LIVE_PACKAGE_ID],
  });

  await host.startMonitoring({
    conversationId: convo.id,
    modFolder: folder,
    isolated: true,
  });
  host.startLiveSession(convo.id);
  track({ name: 'live_session_launched' });

  return { folder, conversationId: convo.id };
}

function liveUnavailableMessage(
  skipReason: string | undefined,
): string {
  switch (skipReason) {
    case 'rimworld-missing':
      return 'RimWorld install not found — set the install path in Settings before launching a live session.';
    case 'not-built':
      return 'The bundled Modmixer Live mod has no compiled assembly (development build without vendor/modmixer-live/Assemblies). Build it with dotnet first.';
    case 'source-missing':
      return 'The bundled Modmixer Live mod is missing from this install — reinstall Modmixer.';
    default:
      return 'The Modmixer Live in-game mod could not be installed.';
  }
}

/**
 * Write the session mod skeleton directly (not via the scaffold_mod tool —
 * that's agent-facing and scope-coupled). XML-only at boot: Assemblies/ is
 * intentionally absent so the initial launch loads it as a contentless
 * mod; the first apply_live hot-builds and hot-loads the C# side.
 */
async function scaffoldSessionMod(displayName: string): Promise<string> {
  const { workspaceDir } = getWorkspacePaths();
  const { managedDir } = detectRimWorldPaths();
  const folder = mintWorkspaceFolderId(workspaceDir);
  const modPath = path.join(workspaceDir, folder);
  const settings = loadSettings();
  const stamp = Date.now().toString(36);
  const packageId = `${settings.defaultAuthor || 'modmixer'}.live${stamp}`;
  const version = detectGameVersionMajorMinorSync() ?? '1.5';

  for (const d of ['About', 'Defs', 'Patches', 'Source']) {
    await fsp.mkdir(path.join(modPath, d), { recursive: true });
  }

  await fsp.writeFile(
    path.join(modPath, 'About', 'About.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<ModMetaData>
  <name>${escapeXml(displayName)}</name>
  <packageId>${escapeXml(packageId)}</packageId>
  <author>Modmixer</author>
  <description>Built live, in-game, with Modmixer.</description>
  <supportedVersions>
    <li>${escapeXml(version)}</li>
  </supportedVersions>
</ModMetaData>
`,
    'utf8',
  );

  const hint = (dll: string) => (managedDir ? path.join(managedDir, dll) : '');
  // Lib.Harmony with runtime assets excluded: the Live mod already loads
  // 0Harmony in-game, and hot assemblies must bind to THAT copy, not ship
  // a second one.
  await fsp.writeFile(
    path.join(modPath, 'Source', 'LiveSession.csproj'),
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net472</TargetFramework>
    <AssemblyName>LiveSession</AssemblyName>
    <RootNamespace>LiveSession</RootNamespace>
    <OutputPath>..\\Assemblies\\</OutputPath>
    <AppendTargetFrameworkToOutputPath>false</AppendTargetFrameworkToOutputPath>
    <CopyLocalLockFileAssemblies>false</CopyLocalLockFileAssemblies>
    <Nullable>disable</Nullable>
    <LangVersion>latest</LangVersion>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NETFramework.ReferenceAssemblies" Version="1.0.3" PrivateAssets="all" />
    <PackageReference Include="Lib.Harmony" Version="2.3.3" ExcludeAssets="runtime" />
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
`,
    'utf8',
  );

  await fsp.writeFile(
    path.join(modPath, 'Source', 'LivePatches.cs'),
    `using HarmonyLib;
using RimWorld;
using Verse;

namespace LiveSession
{
    // Persistent features for this live session live here (and in sibling
    // files): Harmony patch classes + static logic only. No custom
    // ThingComp/MapComponent subclasses, no instance state — persistent
    // values go through ModMixer.Live.LiveState. apply_live re-applies
    // every [HarmonyPatch] in this assembly on each iteration.
    public static class LivePatches
    {
    }
}
`,
    'utf8',
  );

  return folder;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
