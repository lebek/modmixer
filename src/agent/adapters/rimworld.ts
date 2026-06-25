/**
 * RimWorld adapter. Thin binding of the rimworld/* behavior modules to the
 * GameAdapter interface. RimWorld used to be the codebase's ambient default
 * (its logic woven through the tools); this makes it a peer of Minecraft.
 */
import path from 'node:path';
import fsp from 'node:fs/promises';
import { getGame } from '../games/registry.js';
import { scaffoldRimworldMod } from '../rimworld/scaffold.js';
import { buildRimworldMod } from '../rimworld/build.js';
import { runRimworldTestCycle } from '../rimworld/test.js';
import { rimworldSetup } from '../rimworld/setup.js';
import {
  readModAbout,
  writeAbout,
  renderFreshAboutXml,
  emptyAbout,
  type AboutMetadata,
} from '../workspace.js';
import type {
  GameAdapter,
  MetadataWriteResult,
} from './types.js';

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
  readModMetadata: (_modDir, folder) => readModAbout(folder),
  writeModMetadata,
  createPlaceholder,
  scaffold: scaffoldRimworldMod,
  build: buildRimworldMod,
  test: runRimworldTestCycle,
};
