/**
 * RimWorld adapter. Thin binding of the rimworld/* behavior modules to the
 * GameAdapter interface. RimWorld used to be the codebase's ambient default
 * (its logic woven through the tools); this makes it a peer of Minecraft.
 */
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { getGame } from '../games/registry.js';
import { scaffoldRimworldMod } from '../rimworld/scaffold.js';
import { buildRimworldMod } from '../rimworld/build.js';
import { runRimworldTestCycle } from '../rimworld/test.js';
import { rimworldSetup } from '../rimworld/setup.js';
import { buildRimworldSystemPrompt } from '../system-prompt.js';
import { rimworldResearchTools } from '../rimworld/research-tools.js';
import { ensureRimworldIndexAtStartup } from '../index/main-bridge.js';
import { getIndexStatus } from '../index/rebuild.js';
import {
  readModAbout,
  writeAbout,
  renderFreshAboutXml,
  emptyAbout,
  parseAbout,
  type AboutMetadata,
} from '../workspace.js';
import type {
  GameAdapter,
  GameIndexAdapter,
  MetadataWriteResult,
} from './types.js';

/** RimWorld index: eager startup build; symbol DB needs a pre-query status check. */
const index: GameIndexAdapter = {
  ensureAtStartup: ensureRimworldIndexAtStartup,
  ensureForSession: () => {},
  symbolDbReady: () => {
    const status = getIndexStatus();
    return status.type !== 'absent' && status.type !== 'no-rimworld';
  },
};

const scaffoldDescription =
  "Set up a RimWorld mod's About.xml, README, and standard subfolders (About/, Defs/, Patches/, Source/, Textures/). Pass withCSharp=true to also generate a buildable .csproj + Mod.cs. The mod folder itself is an opaque internal id — when the active conversation is already bound to a mod (including the placeholder from \"+ new mod\"), scaffold_mod operates on that folder. Otherwise it mints a fresh folder id; do NOT try to control the folder name via `name`. The mod is NOT yet active in the game — run_test_cycle handles sync + enable + launch when you're ready to test.";

const testCycleDescription =
  "Macro: the only way to test a mod in-game. Handles the entire flow in one call — flips dev-mode + pins palette entries in Prefs.xml, syncs the mod into RimWorld's Mods/, installs the Modmixer Bridge mod (Harmony-patched diagnostics over localhost TCP), writes an active-mod list (Core + DLCs + target + transitive deps + any companionMods + bridge) to a separate savedata folder by default so the user's real mod list is untouched, launches RimWorld with `-quicktest`, and arms background bridge monitoring. If RimWorld is already running it's force-quit and relaunched automatically — never ask about unsaved progress (Modmixer users are mod-testing; saves don't matter). After this returns, tell the user EXACTLY what to do in-game (they're about to alt-tab) — errors will arrive automatically as '[automated …]' messages via the standard error-triage protocol.";

/** A RimWorld placeholder is About.xml with an empty <packageId>. */
function isPlaceholderMod(modDir: string): boolean {
  try {
    const xml = fs.readFileSync(path.join(modDir, 'About', 'About.xml'), 'utf8');
    return parseAbout(xml).packageId.trim() === '';
  } catch {
    return false;
  }
}

/** RimWorld identity lives in About.xml. */
async function writeModMetadata(
  _modDir: string,
  folder: string,
  patch: Partial<AboutMetadata>,
): Promise<MetadataWriteResult> {
  const updated = await writeAbout(folder, patch);
  if (!updated) {
    throw new Error(`Mod folder not found: ${folder}. Run scaffold_mod first.`);
  }
  const summary = Object.entries(patch)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(', ');
  return {
    changed: Object.keys(patch),
    message: `Updated About.xml for ${folder} (${summary}). The Settings panel reflects this now.`,
  };
}

/** Mint the placeholder About.xml + standard subdirs for a new untitled mod. */
async function createPlaceholder(
  modDir: string,
  opts: { author: string },
): Promise<void> {
  const subdirs = ['About', 'Defs', 'Patches', 'Source', 'Textures'];
  await Promise.all(
    subdirs.map((d) => fsp.mkdir(path.join(modDir, d), { recursive: true })),
  );
  const aboutXml = renderFreshAboutXml({
    ...emptyAbout('Untitled Mod'),
    author: opts.author,
  });
  await fsp.writeFile(path.join(modDir, 'About', 'About.xml'), aboutXml, 'utf8');
}

export const RimWorldAdapter: GameAdapter = {
  def: getGame('rimworld'),
  setup: rimworldSetup,
  index,
  toolText: { scaffold: scaffoldDescription, testCycle: testCycleDescription },
  isPlaceholderMod,
  readModMetadata: (_modDir, folder) => readModAbout(folder),
  writeModMetadata,
  createPlaceholder,
  buildSystemPrompt: buildRimworldSystemPrompt,
  researchTools: rimworldResearchTools,
  scaffold: scaffoldRimworldMod,
  build: buildRimworldMod,
  test: runRimworldTestCycle,
};
