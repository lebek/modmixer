/**
 * Minecraft (NeoForge) lore taxonomy — a separate topic set from RimWorld's,
 * reflecting NeoForge concepts so the agent never sees RimWorld slots for a
 * Minecraft mod. Pure, renderer-safe data referenced by the descriptor; the lore
 * engine reads it via getGame('minecraft').lore.
 */
export const minecraftLoreTopics = [
  // Core
  'registries',
  'events',
  'datagen',
  'capabilities',
  'networking',
  // Content
  'blocks',
  'items',
  'entities',
  'recipes',
  'loot-tables',
  'tags',
  'worldgen',
  // Presentation
  'rendering',
  'models',
  'lang',
  // Advanced
  'mixins',
  'commands',
  // Author workflow
  'build',
  'test-loop',
  'assets',
  'distribution',
  'misc',
] as const;

export const minecraftLoreTopicHints: Record<string, string> = {
  registries: 'DeferredRegister, Registries keys, RegisterEvent, registration timing on the mod bus.',
  events: 'Mod bus (FMLCommonSetupEvent, register events) vs game bus (NeoForge.EVENT_BUS), @SubscribeEvent, event priorities.',
  datagen: 'Data generators, GatherDataEvent, providers for recipes/loot/tags/models, runData task.',
  capabilities: 'Capabilities/attachments (IItemHandler, IEnergyStorage), RegisterCapabilitiesEvent, data attachments.',
  networking: 'Custom payloads, PayloadRegistrar, client/server packet handling, sync.',
  blocks: 'Block + BlockBehaviour.Properties, BlockState, block entities, BlockItem pairing.',
  items: 'Item + Item.Properties, Tiers/SimpleTier, components (DataComponents), creative tabs.',
  entities: 'EntityType, attributes, renderers, goals/AI, spawn eggs, datafix.',
  recipes: 'JSON recipe shapes (crafting_shaped/shapeless/smelting), RecipeType, custom serializers.',
  'loot-tables': 'Loot table JSON, pools, entries, conditions/functions, block drops.',
  tags: 'Tag JSON (item/block/biome…), TagKey, referencing tags in code/recipes.',
  worldgen: 'Features, placement modifiers, biome modifiers, structures via JSON + datapack.',
  rendering: 'Client renderers, RenderType, model layers, GUI screens, ScreenEvent.',
  models: 'Item/block model JSON, blockstate JSON, parents (item/handheld, block/cube_all), textures.',
  lang: 'Translation keys (item./block./itemGroup.), en_us.json, Component.translatable.',
  mixins: 'Mixin setup, refmap, injection points; prefer events/APIs first.',
  commands: 'Brigadier commands, RegisterCommandsEvent, argument types.',
  build: 'gradle.properties, build.gradle (ModDevGradle), gradlew tasks, dependencies, Parchment.',
  'test-loop': 'runClient, the diagnostics bridge, reading aggregated errors, datagen runData.',
  assets: 'src/main/resources layout (assets/<id>, data/<id>), textures (png), placeholder strategy.',
  distribution: 'neoforge.mods.toml, mod id/version, Modrinth publishing, loaders/game_versions.',
  misc: "Anything that doesn't fit elsewhere — use sparingly.",
};
