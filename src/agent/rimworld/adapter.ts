/**
 * RimWorld adapter. Thin binding of the rimworld/* behavior modules to the
 * GameAdapter interface. RimWorld used to be the codebase's ambient default
 * (its logic woven through the tools); this makes it a peer of Minecraft.
 */
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { getGame } from '../games/registry.js';
import { buildRimworldMod } from './build.js';
import { runRimworldTestCycle, rimworldTestCycleParams } from './test.js';
import { rimworldSetup } from './setup.js';
import { buildRimworldSystemPrompt } from '../system-prompt.js';
import { rimworldResearchTools } from './research-tools.js';
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
} from '../adapters/types.js';

/** RimWorld index: eager startup build; symbol DB needs a pre-query status check. */
const index: GameIndexAdapter = {
  ensureAtStartup: ensureRimworldIndexAtStartup,
  ensureForSession: () => {
    /* RimWorld's index builds eagerly at startup; nothing to do per session. */
  },
  symbolDbReady: () => {
    const status = getIndexStatus();
    return status.type !== 'absent' && status.type !== 'no-rimworld';
  },
};

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
    throw new Error(`Mod folder not found: ${folder}.`);
  }
  const summary = Object.entries(patch)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(', ');
  return {
    changed: Object.keys(patch),
    message: `Updated About.xml for ${folder} (${summary}). The Settings panel reflects this now.`,
  };
}

/**
 * Mint the placeholder About.xml + standard subdirs for a new untitled mod.
 * XML-only by default — no C# project is laid down, so mods that never need
 * runtime code carry no dead .csproj / build overhead. The agent calls the
 * add_csharp tool to add a buildable Source/ project when the mod needs code.
 */
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
  toolText: { testCycle: testCycleDescription },
  testCycleParams: rimworldTestCycleParams,
  isPlaceholderMod,
  readModMetadata: (_modDir, folder) => readModAbout(folder),
  writeModMetadata,
  createPlaceholder,
  buildSystemPrompt: buildRimworldSystemPrompt,
  researchTools: rimworldResearchTools,
  build: buildRimworldMod,
  test: runRimworldTestCycle,
};
