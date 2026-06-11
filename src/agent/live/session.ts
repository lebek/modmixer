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
import {
  ensureLiveInstalled,
  LIVE_PACKAGE_ID,
  LIVE_REQUIRED_VERSION,
  LIVE_WORKSHOP_URL_STEAM,
  LIVE_WORKSHOP_URL_WEB,
  type LiveInstallResult,
} from './install.js';
import { prewarmLiveBuilds } from './build.js';
import { setActiveForMod } from '../conversations.js';
import { track } from '../telemetry.js';
import { getAgentHost } from '../agent-host.js';

export interface LiveSessionLaunch {
  folder: string;
  conversationId: string;
}

/**
 * Launch outcome for the renderer. Availability gates (mod not subscribed,
 * non-Steam install, …) come back as `ok: false` with a user-facing message
 * — and Workshop links when subscribing/updating would fix it — because
 * ipcMain.handle rejections only carry Error.message, not extra fields.
 * Unexpected failures still throw and surface via the renderer's catch.
 */
export type LiveLaunchResult =
  | ({ ok: true } & LiveSessionLaunch)
  | {
      ok: false;
      /** skipReason from ensureLiveInstalled. */
      reason: string;
      message: string;
      /** Steam-client deep link to the Workshop page, when relevant. */
      steamUrl?: string;
      /** Browser fallback for the same page. */
      webUrl?: string;
    };

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

export async function launchLiveSession(): Promise<LiveLaunchResult> {
  // The Live mod must be available before we scaffold anything — a session
  // without the in-game channel is just a confusing test cycle. Clicking
  // "Launch Live Session" again after subscribing is the retry path: the
  // refresh below re-scans the Workshop dir.
  const registry = getRegistry();
  await registry.start();
  await registry.refresh();
  const live = await ensureLiveInstalled(registry.getSnapshot());
  // One decisive line in the dev terminal: which copy of the Live mod this
  // session will load (dev junction vs Workshop) and why.
  console.log(
    `[live] install: available=${live.available} installed=${live.installed} via=${live.skipReason ?? 'dev-junction'}`,
  );
  if (!live.available) {
    const fixableOnWorkshop =
      live.skipReason === 'not-subscribed' || live.skipReason === 'stale-version';
    return {
      ok: false,
      reason: live.skipReason ?? 'unknown',
      message: liveUnavailableMessage(live),
      ...(fixableOnWorkshop
        ? { steamUrl: LIVE_WORKSHOP_URL_STEAM, webUrl: LIVE_WORKSHOP_URL_WEB }
        : {}),
    };
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

  // Warm MSBuild + NuGet for both build flavors while the rest of the
  // launch (and the game boot, ~a minute) proceeds — otherwise the first
  // apply_live / game_action of the session pays the cold start.
  void prewarmLiveBuilds(folder);

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

  return { ok: true, folder, conversationId: convo.id };
}

function liveUnavailableMessage(live: LiveInstallResult): string {
  switch (live.skipReason) {
    case 'rimworld-missing':
      return 'RimWorld install not found — set the install path in Settings before launching a live session.';
    case 'not-built':
      return 'vendor/modmixer-live has no compiled assembly — build it with dotnet before launching a live session (dev checkout only).';
    case 'steam-required':
      return 'Live sessions need RimWorld installed through Steam — the Modmixer Live companion mod is distributed on the Steam Workshop, and this RimWorld install can\'t use Workshop mods.';
    case 'not-subscribed':
      return 'Live sessions use the Modmixer Live companion mod from the Steam Workshop. Subscribe on the Workshop page, give Steam a moment to download it, then launch again.';
    case 'stale-version':
      return `Modmixer Live v${live.installedVersion || '0'} is installed, but this version of Modmixer needs v${LIVE_REQUIRED_VERSION}. Steam updates Workshop mods automatically — make sure Steam is online (or restart it), then launch again.`;
    default:
      return 'The Modmixer Live in-game mod could not be installed.';
  }
}

/**
 * Write the session mod skeleton directly (not via the scaffold_mod tool —
 * that's agent-facing and scope-coupled). XML-only at boot: Assemblies/ is
 * intentionally absent so the first apply_live hot-builds and hot-loads the
 * C# side. An (empty) keyed-strings file is scaffolded because RimWorld
 * error-logs any mod where AnyContentLoaded() is false — and a Languages/
 * folder containing any file at all satisfies it (AnyTranslationsLoaded is
 * a pure file-existence check), with none of the load cost or gameplay
 * surface that a placeholder def or patch would carry.
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

  const keyedDir = path.join(modPath, 'Languages', 'English', 'Keyed');
  await fsp.mkdir(keyedDir, { recursive: true });
  await fsp.writeFile(
    path.join(keyedDir, 'LiveSession.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<!-- Keyed UI strings for this mod (empty is fine). This file's presence is
     also what stops RimWorld from error-logging the mod as "did not load
     any content" before the first live change lands. -->
<LanguageData>
</LanguageData>
`,
    'utf8',
  );

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
