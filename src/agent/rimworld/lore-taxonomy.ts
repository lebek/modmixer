/**
 * RimWorld's lore taxonomy — the topic slots and one-line routing hints the
 * agent sees when reading/saving lessons. Pure, renderer-safe data referenced by
 * the descriptor (see games/types.ts LoreTaxonomy); the lore engine reads it via
 * getGame('rimworld').lore so no game branch is needed at the call sites.
 */
export const rimworldLoreTopics = [
  // Engine systems
  'defs',
  'patches',
  'harmony',
  'scribe-saving',
  'performance',
  'localization',
  // Presentation
  'ui',
  'sounds',
  'textures',
  'animation',
  // Game subsystems
  'pawns',
  'things',
  'recipes',
  'jobs-ai',
  'combat',
  'world-incidents',
  'weather',
  'biomes',
  'factions',
  'ideology',
  'biotech',
  'anomaly',
  // Author workflow
  'build',
  'test-loop',
  'debugging',
  'compat',
  'assets',
  'distribution',
  // Catch-all
  'misc',
] as const;

export const rimworldLoreTopicHints: Record<string, string> = {
  // Engine systems
  defs: 'Def system mechanics, parentName/abstract resolution, def lookup timing, DefDatabase quirks.',
  patches: 'PatchOperations (Add/Replace/Insert), XPath shape, named vs wildcard targets, Patch ordering.',
  harmony: 'Harmony patches, prefix/postfix/transpiler patterns, when to use Harmony vs alternatives.',
  'scribe-saving': 'Save/load via Scribe_*, IExposable, ExposeData, Look* helpers, savegame compatibility.',
  performance: 'Tick budgets, ThingComp/MapComponent overhead, GC pressure, profiling, hot paths.',
  localization: 'Languages/, Keyed/ vs DefInjected/, translation injection, runtime string lookup.',
  // Presentation
  ui: 'Widgets, Listing_Standard, Window subclasses, ITab, Gizmo, Inspector tab, MainTab.',
  sounds: 'SoundDef shape, SubSoundDef, sustainers, OneShot, FMOD/Unity audio quirks, .ogg encoding.',
  textures: 'PNG conventions, texPath resolution, GraphicData, atlasing, shaders.',
  animation: 'Sprite swaps, PawnRenderer, AnimationDef, smooth interpolation, body/apparel layering.',
  // Game subsystems
  pawns: 'Pawn generation, kinds, traits, skills, hediffs, needs, body parts, stats, age/biology.',
  things: 'ThingDef shape, Building/Pawn/Plant subclasses, ThingComp, stuff/material system, spawning.',
  recipes: 'RecipeDef, ingredients, work amount, workSkill, surgical recipes, bills, RecipeUser.',
  'jobs-ai': 'JobDef, JobDriver, ThinkTree/ThinkNode, WorkGiver, mental states, pawn AI extensions.',
  combat: 'Verbs, Verb_Shoot/Melee, ProjectileDef, damage calc, armor, cover, ranged accuracy.',
  'world-incidents': 'IncidentDef, IncidentWorker, GameCondition, storyteller comps, raid generation.',
  weather: 'WeatherDef, WeatherOverlay, sky color, wind, rain/snow, MusicManager interactions.',
  biomes: 'BiomeDef, world tiles, terrain generation, plant/animal density, weather chains.',
  factions: 'FactionDef, PawnGroupMaker, relations, settlements, faction-specific raids.',
  ideology: 'PreceptDef, MemeDef, IdeoDef, rituals, role abilities (DLC: Ideology).',
  biotech: 'GeneDef, xenotypes, mechanitor/mech, growth stages, ChildAgeRequirements (DLC: Biotech).',
  anomaly: 'EntityDef, study, void/dark mechanics, monolith, suppression (DLC: Anomaly).',
  // Author workflow
  build: 'csproj, target framework, references, NuGet packages, Assembly-CSharp/UnityEngine DLLs.',
  'test-loop': 'Iteration cadence: dev console, hot-reload tricks, ModSettings sliders, MapComponent tuning.',
  debugging: 'Reading Player.log, triaging errors by mod, decompile_dll usage, log severity classification.',
  compat: 'HugsLib, mod ordering, soft dependencies, optional Harmony patches, version detection.',
  assets: 'Filesystem layout (Sounds/, Textures/), naming, .ogg/.png encoding requirements, placeholder strategy.',
  distribution: 'About.xml, packageId conventions, supportedVersions, Workshop publishing, PublishedFileId.',
  // Catch-all
  misc: "Anything that doesn't fit elsewhere — use sparingly. If lessons cluster here, propose a new topic.",
};
