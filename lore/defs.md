## `Could not find parent node named "RawPlant"` is a load-order bug, not a typo

The abstract parent isn't yet in the def index when the child resolves. Either declare your mod's load order *after* the owning mod, or copy the abstract `<ThingDef Abstract="True">` into your own defs.

*Why it's tricky:* the error message reads like a misspelled `parentName` but the spelling is fine — it's a timing problem.

## A custom ScenarioDef must declare `surfaceLayer` (or inherit `ScenarioBase`)

Every `ScenarioDef` needs a `<scenario><surfaceLayer>` block (and, for Odyssey, a matching `<parts><li Class="ScenPart_PlanetLayer">` with `MayRequire="Ludeon.RimWorld.Odyssey"`). The cleanest path is `ParentName="ScenarioBase"` (Core) — it provides both. Otherwise inline:

```xml
<surfaceLayer>
  <def>SurfaceLayerFixed</def>
  <tag>Surface</tag>
  <layer>Surface</layer>
  <settingsDef>Surface</settingsDef>
  <hide>true</hide>
  <connections>
    <Orbit MayRequire="Ludeon.RimWorld.Odyssey"><zoomMode>ZoomOut</zoomMode></Orbit>
  </connections>
</surfaceLayer>
```

*Why it's tricky:* the error message is misleading. `Scenario.ConfigErrors` iterates `AllParts` (which yields `playerFaction`, `surfaceLayer`, then `parts[]`) — a null `surfaceLayer` shows up as **"scenario has null part"**, not "no surfaceLayer". You'll hunt your `<parts>` list for ages before realizing the layer field itself is the missing one.

## WorldComponent.FinalizeInit(false) runs before Faction.OfPlayer exists on new games

On a brand-new game, `WorldComponent.FinalizeInit(fromLoad: false)` runs from inside `WorldGenerator.GenerateWorld` — i.e. BEFORE the scenario has created the player faction. Any baseline / setup code that reaches `Faction.OfPlayer`, `Faction.PlayerGoodwill`, or `faction.HostileTo(Faction.OfPlayer)` will throw NRE here (and vanilla also logs `"Could not find player faction."` from `Faction.get_OfPlayer`).

Recipe: in `FinalizeInit`, guard with `if (Faction.OfPlayerSilentFail == null) return;` and write the baseline work as an **idempotent** `TryApplyDeferredInit()` method that flips its own `applied` flag. Then call that same method every frame from a `GameComponent.GameComponentUpdate()` — it no-ops once the flags are set and silently retries on subsequent frames until the player faction shows up. Save-load (`fromLoad=true`) still works on the first call because the player faction is already restored at that point.

*Why it's tricky:* the stack reads `WorldGenerator.GenerateWorld → World.FinalizeInit → WorldComponent.FinalizeInit`, which looks like "world is fully set up" — but the player faction is added later by the scenario. `Faction.OfPlayer` calls `Log.Error` on miss, so the bridge sees a vanilla `[RimWorld]` error first; the NRE in your code is the second message in the cascade.

## WorldComponent.FinalizeInit fires DURING worldgen before Faction.OfPlayer exists — split content seeding into "early" and "late" passes

When a new game is generated, `WorldComponent.FinalizeInit(false)` fires DURING world generation — after factions and settlements are placed, but BEFORE the player faction is created (the scenario creates the player faction AFTER worldgen). On save-load, `FinalizeInit(true)` fires with the player faction already present.

Implication: anything you want visible on the worldgen-selection globe (`Page_SelectStartingSite`) must be seeded WITHOUT depending on `Faction.OfPlayer` / `Faction.OfPlayerSilentFail`. Anything that needs the player faction (or systems initialised after it, like your own per-faction leader generation) must be deferred to `GameComponent.GameComponentUpdate` after a `Faction.OfPlayerSilentFail != null` check.

Recipe for world-map content (markers, sites, landmarks) that should appear at worldgen selection:

1. Split your generator into two static methods: `GenerateEarlyContent(WorldComponent)` (no player/leader deps) and `GenerateAll(WorldComponent)` (player/leader deps).
2. Gate each with a separate scribed `bool *Seeded` flag on your `WorldComponent`.
3. Call `GenerateEarlyContent` from `FinalizeInit(fromLoad)` BEFORE any player-faction check.
4. Call `GenerateAll` from your deferred-init path (the one that retries on every `GameComponentUpdate` until `Faction.OfPlayerSilentFail != null`).

*Why it's tricky:* the obvious place to seed world objects is `FinalizeInit` or `WorldComponentUpdate`, and both look like they should work. But `FinalizeInit` runs too early for anything player-dependent, while `WorldComponentUpdate` runs too late (after the user has already seen the empty selection globe). Splitting the generator is the only clean fix; there's no single hook where "after world-gen factions placed AND player faction exists AND we're still on the selection globe" is true — because the moment Faction.OfPlayer exists, the player has already picked their tile.

## WorkTags enum value is Constructing, not Construction — different from the WorkTypeDef defName

The `Verse.WorkTags` enum flag is `Constructing` (gerund), but the vanilla `WorkTypeDef.defName` is `Construction` (noun). They look interchangeable but aren't:

- `<workDisables>Mining, Constructing, Hauling</workDisables>` ✓ — parses to WorkTags flags
- `<workDisables>Mining, Construction, Hauling</workDisables>` ✗ — throws `ArgumentException: 'Mining, Construction, Hauling' is not a valid value for Verse.WorkTags`

Full enum (1.6): None, ManualDumb, ManualSkilled, Violent, Caring, Social, Commoner, Intellectual, Animals, Artistic, Crafting, Cooking, Firefighting, Cleaning, Hauling, PlantWork, Mining, Hunting, **Constructing**, Shooting, AllWork.

This bites BackstoryDef.workDisables, TraitDef.disabledWorkTags, anywhere WorkTags is read from XML. The error message helpfully lists every valid value, which is the fastest way to recover — but if you skim the error you'll fix one wrong-name and miss others in the same comma-list.

*Why it's tricky:* `WorkTypeDef`s use the noun form (`Construction`, `Hunting`, `Plant`), `WorkTags` enum uses the gerund/-ing form (`Constructing`, `Hunting`, `PlantWork`). Most pairs accidentally match, so the brain pattern-matches "obviously the same name" — until Construction/Constructing or Plant/PlantWork breaks the assumption.
