/**
 * RimWorld adapter. Thin binding of the rimworld/* behavior modules to the
 * GameAdapter interface. RimWorld used to be the codebase's ambient default
 * (its logic woven through the tools); this makes it a peer of Minecraft.
 */
import { getGame } from '../games/registry.js';
import { scaffoldRimworldMod } from '../rimworld/scaffold.js';
import { buildRimworldMod } from '../rimworld/build.js';
import { runRimworldTestCycle } from '../rimworld/test.js';
import type { GameAdapter } from './types.js';

export const RimWorldAdapter: GameAdapter = {
  def: getGame('rimworld'),
  scaffold: scaffoldRimworldMod,
  build: buildRimworldMod,
  test: runRimworldTestCycle,
};
