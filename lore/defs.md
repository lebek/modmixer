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

## FactionDef has no pawnNameMaker; generate pawn names via temp PawnGenerator call

`FactionDef` does NOT have a `pawnNameMaker` field (that lives on `CultureDef`, not `FactionDef`). `RulePackDefOf.NamerPersonGeneral` does not exist either. When you need a faction-appropriate pawn name string (e.g. for flavor officer lists that don't need real Pawn objects), generate a throwaway pawn and extract its label:

```csharp
static string GenerateNPCName(Faction faction) {
    try {
        var kind = faction.def.basicMemberKind ?? PawnKindDefOf.Villager;
        var req = new PawnGenerationRequest(kind, faction,
            PawnGenerationContext.NonPlayer, forceGenerateNewPawn: true,
            allowDead: false, allowDowned: false);
        var pawn = PawnGenerator.GeneratePawn(req);
        string name = pawn.LabelShortCap;
        if (Find.WorldPawns.Contains(pawn)) Find.WorldPawns.RemovePawn(pawn);
        pawn.Destroy();
        return name;
    } catch { return "Officer"; }
}
```

*Why it's tricky:* `FactionDef.factionNameMaker` exists (generates settlement/faction names) but that's culturally wrong for pawn names. `CultureDef.pawnNameMaker` is correct but you need `faction.ideos?.PrimaryCulture?.pawnNameMaker` which can be null when ideos aren't loaded. The temp-pawn pattern is one extra generation call but is guaranteed to produce a culturally correct name with zero research overhead.

## To stop inherited colorGenerator randomization, override `<options Inherit="False">` with one white entry — don't change the colorGenerator's Class

When a ThingDef inherits from `ApparelArmorPowerBase` (or any parent with a `<colorGenerator>`), spawned items get a random color from the parent's list. To suppress this you must:

1. Keep the SAME `Class="ColorGenerator_Options"` as the parent (don't switch to `ColorGenerator_White` or `ColorGenerator_Single`).
2. Add `Inherit="False"` on the `<options>` LIST, then provide one white entry.

```xml
<colorGenerator Class="ColorGenerator_Options">
  <options Inherit="False">
    <li><only>(1,1,1,1)</only></li>
  </options>
</colorGenerator>
```

*Why it's tricky:*
- Removing your local `<colorGenerator>` doesn't help — XML inheritance still pulls in the parent's full block.
- `<colorGenerator Inherit="False" />` doesn't work on non-list scalar fields the way it does on list `<li>`s.
- Switching `Class="ColorGenerator_White"` throws `XML error: <options>...` because RimWorld's inheritance merger tries to fold the parent's `<options>` list into your new class — `ColorGenerator_White` doesn't have an `options` field, so the merge fails before any code runs.
- A single option `<only>(1,1,1)</only>` (RGB only, no alpha) may still randomize because `ColorOption.only` defaults to `(-1,-1,-1,-1)` and the `RandomizedColor()` check is `if (only.a >= 0f)` — if alpha parses as -1 (default), it falls through to the `Rand.Range(min, max)` path. Always write `(1,1,1,1)` with explicit alpha to be safe.

The fix combines all three: keep the parent's Class, use `Inherit="False"` on the LIST (not the scalar), and write explicit alpha.

## ThingDef defNames cannot end with digits

If a `ThingDef` `defName` ends in a numeric digit, RimWorld logs `Config error in X: ends with a numerical digit, which is not allowed on ThingDefs.` Rename the identifier so it ends with letters instead (for example, append `SMG`), and keep the player-facing `<label>` unchanged if you still want a numbered item name.

*Why it's tricky:* numbered weapon names look natural in defs, but this restriction is only enforced at load time.

## Inside WorldComponent.FinalizeInit during regen, use this.world — Find.World still points at the previous Game.World

`WorldComponent.FinalizeInit(false)` runs from inside `WorldGenerator.GenerateWorld` against the new world being built. But that new world is `Current.CreatingWorld` at that point — `Current.Game.World` is still set to the *previous* world (if any). `Find.World` short-circuits: returns `Current.Game.World` whenever it's non-null, otherwise `Current.CreatingWorld`.

Implication for the **first** worldgen: `Game.World` is null, so `Find.World` correctly returns CreatingWorld, and any code using `Find.World` / `Find.WorldGrid` Just Works.

Implication for **second-and-later** worldgens (the user backed up from the world preview and regenerated): `Game.World` is still pointing at the *previous* world. `Find.World.grid` now returns the old planet's grid; `Find.World.info.Seed` returns the old seed. Any generation step that iterates `Find.WorldGrid.TilesCount` and stores tile-id-keyed data on the new WorldComponent populates with the old planet's tile IDs — the new world ends up with no generated content even though the code ran without errors.

Recipe: from inside a `WorldComponent` method, always use `this.world` (the public `world` field on `WorldComponent`), never `Find.World` / `Find.WorldGrid`.

```csharp
public override void FinalizeInit(bool fromLoad)
{
    base.FinalizeInit(fromLoad);
    if (!generated)
    {
        var grid = world.grid;          // ← yours; do NOT use Find.WorldGrid
        int seed = world.info.Seed;     // ← yours; do NOT use Find.World.info.Seed
        // ... generate ...
    }
}
```

*Why it's tricky:* every example you'll find uses `Find.World` because it's the idiomatic accessor in 95% of code. The bug is invisible on the first worldgen and only fires on regen, which most modders don't test. The symptom (regenerated worlds have zero of your content) reads like a settings-not-persisting issue or a worldgen-step ordering issue — not "I used the wrong world object reference".

## Def fields of type Type only auto-resolve short names in vanilla namespaces — modded types need FQN

When a Def field has type `System.Type` (or `List<Type>`), the XML loader resolves the string via `GenTypes.GetTypeInAnyAssembly(name)`. That helper only does a bare-name lookup in the vanilla "ignored" namespace whitelist:

```
RimWorld, Verse, LudeonTK, Verse.AI, Verse.AI.Group, Verse.Sound, Verse.Grammar,
RimWorld.Planet, RimWorld.BaseGen, RimWorld.QuestGen, RimWorld.SketchGen, System
```

Any other namespace (i.e. yours) must be written out as a fully-qualified name in the XML or the loader logs `Could not find a type named <X>` and the def's Type field is left null. Downstream code that iterates that field usually doesn't null-check, producing a cascade of NREs in `ConfigErrors()` and `WorldGenerator`-style async events.

Examples that bite:
- `PlanetLayerDef.worldDrawLayers` is `List<Type>`. `<li>WorldDrawLayer_Pollution</li>` works (vanilla namespace `RimWorld.Planet`); `<li>WorldDrawLayer_Radiation</li>` does NOT if your class is in `MyMod.WorldDrawLayer_Radiation`. Write `<li>MyMod.WorldDrawLayer_Radiation</li>`.
- `IncidentDef.workerClass`, `JobDef.driverClass`, `HediffDef.hediffClass`, anywhere a Type field appears in XML.
- `<Class="X">` attribute (Hediff comps, etc.) follows the same rule for the same reason.

*Why it's tricky:* the obvious example is `<Class="HediffCompProperties_X"/>` which Just Works for vanilla comps, so you copy the pattern for your own comp and it silently fails. The error message ("Could not find a type named X. Removing.") points at the string but doesn't tell you the namespace whitelist exists. The cascade NRE (`Exception in ConfigErrors() of <Def>: NullReferenceException`) lands ON the def, not your code, so it looks like the def itself is broken. `Class="MyMod.MyComp"` is the always-safe form.

## Def labels cannot contain []{} — RimWorld logs a grammar config error even if you resolve tokens at runtime

If you put a templating token like `{PAWN}` / `{COLONY}` into a Def's `<label>` (or anything validated as a label), RimWorld logs at load: `Config error in <DefName>: label contains illegal character(s): "[]{}". This can cause issues during grammar resolution.` This fires during def validation, before any runtime resolution — so even if your own code later does `label.Replace("{PAWN}", pawn.LabelShort)` when sending the letter, the *def's* stored label is still invalid and shows the raw `{PAWN}` in menus/debug lists.

Recipe: keep tokens out of `<label>` entirely. Put them only in `<description>` / letter body text that you resolve at runtime. If you genuinely need them in a label, set the def's `ignoreIllegalLabelCharacterConfigError` flag — but rewording is cleaner. For generated content, add a build-time guard that rejects any name matching `[\[\]{}]`.

*Why it's tricky:* the error is attributed to `[RimWorld]` (Verse's validator), not your mod, and it's only a warning-level "config error" so the def still loads and works at runtime — easy to dismiss as noise until you notice a letter title literally reads "{PAWN} did a thing".

## CompQuality has no CompProperties_Quality — use bare compClass

Unlike most ThingComps, `CompQuality` has NO matching `CompProperties_Quality` subclass — it uses the base `CompProperties` with `compClass` specified by name. The XML idiom is:

```xml
<comps>
  <li>
    <compClass>CompQuality</compClass>
  </li>
</comps>
```

Writing `<li Class="CompProperties_Quality">…</li>` blows up at def-load with `System.ArgumentException: Could not find type named CompProperties_Quality from node …`, and the entire ThingDef fails to register — which cascades into "No ThingDef named X found" cross-reference errors anywhere the def is referenced (recipes, palette pins, etc.).

*Why it's tricky:* almost every other comp follows the `CompFoo` + `CompProperties_Foo` pairing convention, so it's natural to type-extrapolate. CompQuality is an outlier — there's nothing to configure, so vanilla just declares the compClass inline. Also note: there's no `singleSingularForm` field anywhere; if you see that on a quality comp you saw it in a hallucination, not in vanilla XML.

## Gate an ideo-themed NeedDef via onlyIfCausedByIdeo + PreceptDef.enablesNeeds — no Harmony needed

To make a custom `NeedDef` appear ONLY on pawns whose ideoligion has a specific precept (and disappear entirely otherwise — not just zeroed-out, no bar at all):

```xml
<NeedDef>
  <defName>MyNeed</defName>
  <needClass>MyMod.Need_MyNeed</needClass>
  ...
  <onlyIfCausedByIdeo>true</onlyIfCausedByIdeo>
</NeedDef>

<PreceptDef>
  <defName>MyPrecept_Required</defName>
  ...
  <enablesNeeds>
    <li>MyNeed</li>
  </enablesNeeds>
</PreceptDef>
```

Vanilla's `Pawn_NeedsTracker.ShouldHaveNeed` checks `pawn.Ideo.EnablesNeed(def)` whenever `onlyIfCausedByIdeo` is true, and `Ideo.EnablesNeed` returns true iff any of the ideo's precepts lists the need in `enablesNeeds`. Vanilla then handles add/remove via the existing `AddOrRemoveNeedsAsAppropriate` loop.

If you want multiple precepts (e.g. Required + Neutral variants) to share the same gating but behave differently, put `enablesNeeds` on BOTH and branch on `HasPrecept(...)` inside `Need.NeedInterval` or `Need.ShouldShow` for the per-precept difference (decay rate, mood threshold, etc.).

*Why it's tricky:* the obvious approach is a Harmony postfix on `ShouldHaveNeed` or `AddOrRemoveNeedsAsAppropriate` to add/remove the need — and most older Ideology mods (including the 1.4 version of this one) did exactly that. But the vanilla `enablesNeeds` field has existed since Ideology shipped and is strictly cleaner: no patch surface, no precept-changed-mid-game inconsistency, no risk of double-adds. If you're maintaining a 1.4-era mod and see a `Pawn_NeedsTracker_AddOrRemoveNeedsAsAppropriate` postfix that calls `AddNeed` via reflection, that's the smell — replace it with this two-line def edit.
