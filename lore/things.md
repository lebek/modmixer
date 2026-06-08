## Plant `<preferability>RawBad</preferability>` requires Nutrition > 0 — use `NeverForNutrition` for inedible plants

`Config error in Plant_X: Nutrition == 0 but preferability is RawBad instead of NeverForNutrition`. RimWorld validates that any plant whose nutrition is zero must declare `<preferability>NeverForNutrition</preferability>`. `RawBad` is reserved for plants that *are* edible but unappealing. Either set a non-zero `<statBases><Nutrition>...</Nutrition></statBases>` or downgrade preferability.

*Why it's tricky:* `RawBad` reads like "barely food at all" and feels right for a decorative plant — the engine treats it as a stricter contract than the English suggests. The error only fires at game load, never at mod-build time.

## When placing a blueprint programmatically, only pass stuff if def.MadeFromStuff is true

`GenConstruct.PlaceBlueprintForBuild(def, cell, map, rot, faction, stuff)` accepts a stuff parameter, but passing a non-null `stuff` to a def that isn't `MadeFromStuff` (e.g. `ThingDefOf.Campfire`, most workbenches that bake their material into the def) makes RimWorld emit two errors and null the stuff internally:

```
Got AdjustedCostList for Campfire with stuff WoodLog but is not MadeFromStuff.
MakeThing error: Frame_Campfire is not madeFromStuff but stuff=WoodLog. Setting to null.
```

The blueprint still places, but the log is dirty. Normalize stuff at the helper boundary:

```csharp
if (!def.MadeFromStuff) stuff = null;
else if (stuff == null) stuff = GenStuff.DefaultStuffFor(def);
```

*Why it's tricky:* the obvious tutorial example is `ThingDefOf.Wall` + `ThingDefOf.WoodLog`, which works because Wall IS MadeFromStuff. A generic helper that just always passes a default stuff (WoodLog) for "wooden things" blows up the moment it hits Campfire / TorchLamp / FueledStove / Hopper etc. The error attribution lands on `[RimWorld]` (because the bad cast happens inside CostListCalculator), not on your mod — easy to miss who caused it.

## Zero-WorkToBuild defs (SleepingSpot, growing zone markers) use PlaceNoCostFrame, not Frame

When a `Blueprint` has `TotalMaterialCost().Count == 0` (no costList AND not MadeFromStuff), `WorkGiver_ConstructDeliverResourcesToBlueprints.NoCostFrameMakeJobFor` issues `JobDefOf.PlaceNoCostFrame` instead of the normal frame-construction path. `JobDriver_PlaceNoCostFrame` calls `Toils_Construct.MakeSolidThingFromBlueprintIfNecessary` which calls `Blueprint.TryReplaceWithSolidThing` — the blueprint instantly becomes the finished Thing. No skill check, no fail roll, no Frame created.

Implication: 0-cost defs like `SleepingSpot` and `AnimalSleepingSpot` can NEVER produce "construction botched" floating text. If you see that text, the culprit is a different building entirely (most commonly a Campfire with 200 WorkToBuild and a 0.87%/tick fail roll for low-skill pawns).

*Why it's tricky:* the construction path is invisible from the def — you have to read `WorkGiver_ConstructDeliverResourcesToBlueprints.JobOnThing` and `NoCostFrameMakeJobFor` to see the branch. Also, `JobDriver_ConstructFinishFrame.tickIntervalAction` does `Mathf.Pow(statValue, num / workToBuild)` — if you ever DID route a 0-work def through that path, you'd get `num/0 = Infinity` → `Pow(anything < 1, Infinity) = 0` → fail check always fires. The whole reason PlaceNoCostFrame exists is to dodge this.

## Zone.AddCell rejects cells where any thing has def.CanOverlapZones=false — pre-filter the cell's ThingList

`Zone.AddCell(IntVec3)` walks `Map.thingGrid.ThingsListAt(c)` and errors out (`Log.Error("Added zone over zone-incompatible thing " + thing)`) if any thing in the cell has `def.CanOverlapZones == false`. That includes Blueprints, Frames, Buildings, and most Plants — so checking just `map.zoneManager.ZoneAt(c) == null` and `c.GetEdifice(map) == null` is NOT enough; blueprints and frames are NOT edifices.

Recipe — replicate the engine's predicate exactly before calling AddCell:

```csharp
var things = c.GetThingList(map);
for (int i = 0; i < things.Count; i++)
    if (!things[i].def.CanOverlapZones) return false;
```

*Why it's tricky:* the obvious filters (`Standable`, `ZoneAt(c) == null`, `GetEdifice(map) == null`) cover the visible cases — finished buildings and existing zones. Blueprints look like zones in the sense that they're transient overlays, so it's tempting to assume the engine handles them. It doesn't — AddCell logs an error AND returns without adding the cell, so your zone silently ends up with fewer cells than you placed. Attribution lands on `[RimWorld]` plus your mod because the call stack passes through your AddCell loop.

## WorkToBuild=0 buildings (SleepingSpot) cause infinite "Construction botched" loop for Construction skill <8 — patch FailConstruction

Vanilla `JobDriver_ConstructFinishFrame.tickIntervalAction` does `Rand.Value < 1f - Mathf.Pow(statValue, num / workToBuild)` where `statValue` is `ConstructSuccessChance` (capped at 1.0, value <1.0 for Construction skill <8). For `workToBuild == 0` (SleepingSpot, terrain blueprints, anything free), `num/0 == +Infinity`, `Mathf.Pow(0.95, +Inf) == 0`, the fail check becomes `Rand.Value < 1` — ALWAYS true. The skill check fires BEFORE the workDone increment, so the frame never completes; FailConstruction destroys it, the blueprint respawns, the WorkGiver re-issues PlaceNoCostFrame, infinite "Construction botched" floating text.

Vanilla players don't hit this because they place free buildings with a skilled constructor (skill ≥8 → statValue exactly 1.0 → `Pow(1, +Inf) == NaN` → comparison is false → never fails). Any automated/AI mod that puts low-skill pawns on 0-WorkToBuild blueprints WILL hit it.

Fix — Harmony prefix `Frame.FailConstruction` and convert it into `CompleteConstruction` when `WorkToBuild <= 0`:

```csharp
[HarmonyPatch(typeof(Frame), nameof(Frame.FailConstruction))]
public static class Patch_Frame_FailConstruction_ZeroWork {
    public static bool Prefix(Frame __instance, Pawn worker) {
        if (__instance == null || __instance.WorkToBuild > 0f) return true;
        __instance.CompleteConstruction(worker);
        return false;
    }
}
```

Belt-and-suspenders: also restrict Construction work priority to one designated builder so low-skill pawns don't queue up on every blueprint.

*Why it's tricky:* the failure path is a Mathf.Pow + Rand.Value + comparison buried in an anonymous delegate inside MakeNewToils. Hard to transpile, hard to even find by searching. The actual error mote "Construction botched" attributes to no mod (it's a normal in-game mote), so the bridge doesn't catch it as an exception — only the player's verbal report surfaces it.

## When you want stacking hediffs that escalate label + bonuses, bump severity on existing instead of AddHediff every time

For "kill counter" / "rank progression" hediffs where each event should make the hediff stronger AND change its label, do not call `pawn.health.AddHediff(MakeHediff(def))` every time — RimWorld's HediffSet may merge or duplicate awkwardly. Instead:

```csharp
var existing = pawn.health.hediffSet.GetFirstHediffOfDef(def);
if (existing != null) existing.Severity = Mathf.Min(def.maxSeverity, existing.Severity + 1f);
else { var h = HediffMaker.MakeHediff(def, pawn); h.Severity = 1f; pawn.health.AddHediff(h); }
```

Then in the HediffDef XML, define multiple `<stages>` with `<minSeverity>` thresholds (e.g. 0, 3, 7) and per-stage `<label>` overrides — RimWorld auto-picks the right stage label based on current severity. Result: one entry on the health tab whose label transitions ("slayer" → "sworn slayer" → "legendary slayer") and whose statOffsets scale with kill count.

*Why it's tricky:* with multiple AddHediff calls, you either get N duplicate entries (visual clutter) or RimWorld silently swallows duplicates depending on the hediff class — neither is the "promotion" feel you want. The bump-severity pattern matches how vanilla addiction / drug-tolerance hediffs work.

## "Harvest botched" floating text is from chopping trees, not from construction

English `TextMote_HarvestFailed` = "Harvest\nbotched" — fires from `Plant.PlantCollected` / harvest toils when a pawn rolls below Plants-skill threshold. It is NOT a construction-failure mote (that's `TextMote_ConstructionFail`). Don't conflate them.

When you see "botched" floating text near a build site, the most likely cause is **a tree on the blueprint footprint** that pawns are chopping with low Plants skill — each swing has a per-tick fail roll, low-skill pawns botch most swings, the tree takes minutes to fall, and the player perceives the colony as "stuck on the sleeping spot".

Recipe — if you're placing blueprints programmatically and the colony might land on a tree, pre-filter cells before placement:

```csharp
foreach (var c in GenAdj.OccupiedRect(center, rot, def.Size))
{
    foreach (var t in c.GetThingList(map))
        if (t?.def?.plant?.IsTree == true) return false; // reject this center
}
```

*Why it's tricky:* the player describes the symptom as "construction botched" because the floating text appears on a pawn standing next to a construction blueprint. The text is actually about the tree they're chopping, not the blueprint. `CutPlant` on a tree DOES eventually succeed even with low skill (failure damages tree progress slightly but never resets it), but with botch rates >50% the player calls it broken before it finishes.

## Never modify lists returned by listerThings.ThingsOfDef or ThingsInGroup

`map.listerThings.ThingsOfDef(def)` and `map.listerThings.ThingsInGroup(group)` return **references to the internal lists**, not copies. Calling `.Add()`, `.Remove()`, or any mutation on these lists **corrupts the group membership system**, causing InvalidCastExceptions when code later tries to cast items from a group to a specific type (e.g., casting a Blueprint as a Corpse because it was wrongly added to the Corpses group).

**Fix**: Always iterate read-only, or make a shallow copy if you need to collect results: `var copy = new List<Thing>(map.listerThings.ThingsOfDef(def));` then mutate the copy.

*Why it's tricky:* The API doesn't signal that these are internal references — it looks like a normal method that returns a list, so the mistake is easy to make. The corruption is silent until a cast fails deep in pathfinding or alert code, and the error is then attributed to the wrong system.

## For a custom NPC world-map mover with smooth motion + pawn roster + save/load, subclass Caravan not WorldObject

When you need a custom NPC entity that walks tile-to-tile on the world map and carries a pawn roster (armies, war bands, mercenary companies, etc.), **subclass `RimWorld.Planet.Caravan`** and author your own `WorldObjectDef` with `<worldObjectClass>YourSubclass</worldObjectClass>`. Spawning pattern (mirror `CaravanMaker.MakeCaravan` but with your def):

```csharp
var def = DefDatabase<WorldObjectDef>.GetNamedSilentFail("YourArmy");
var army = (YourArmy)WorldObjectMaker.MakeWorldObject(def);
army.Tile = startTile;
army.SetFaction(faction);
Find.WorldObjects.Add(army);
foreach (var p in pawns) {
    army.AddPawn(p, addCarriedPawnToWorldPawnsIfAny: true);
    if (!p.IsWorldPawn()) Find.WorldPawns.PassToWorld(p);
}
army.SetUniqueId(Find.UniqueIDsManager.GetNextCaravanID());
army.pather.StartPath(targetTile, new YourArrivalAction(), repathImmediately: true);
```

You inherit: `Caravan_Tweener.TweenedPos` for free smooth interpolation (just override `DrawPos` to add a sine bob if you want); the pawn-cluster icon render; faction colouring; the selection inspector tabs (gear/health/social); save/load of every pawn and the pather state.

Gotchas: `LordJob_AssaultColony` is in the `RimWorld` namespace not `Verse.AI.Group`. `PawnGroupMakerParms.forceOneIncap` is now `forceOneDowned`. `Find.WorldGrid.ApproxDistanceInTiles` returns `float` not `int`. `Caravan` doesn't have `HasMap` — check `Spawned` or a custom state-machine field instead.

*Why it's tricky:* the temptation is to subclass `WorldObject` directly to get full control, but you then have to reimplement smooth motion, the pawn cluster, the inspect tabs, etc. Caravan already has all of that built; the only thing you give up is being able to disable inventory/needs handling, and for an NPC mover that doesn't matter — non-player caravans coexist with the needs system fine.

## Floating/bobbing custom Things must offset Z (screen-vertical), not Y — Y bob flickers via sort-order swaps

RimWorld's gameplay camera looks straight down +Y, so **Y is sort order, not screen-vertical**. If you bob a custom Thing's draw position by ±N on Y, you'll sweep through several `AltitudeLayer` slots per second; with `shaderType=Transparent` (or even Cutout against transparent neighbors) the sprite flips between drawing in front of and behind nearby pawns/motes every frame — the visible symptom is **flicker**, not floating. Screen-vertical motion goes on **Z**.

Recipe for a floating decorative Thing:
- Override `DrawAt`, not `DrawPos`. `DrawPos` is read by labels, selection brackets, culling, holders, etc.; offsetting it leaks into all of them.
- Put rise/bob on `drawLoc.z`. Leave `drawLoc.y` alone so sort order is stable.
- Wobble on `drawLoc.x` if you want a little sway.
- Pick `altitudeLayer` to match where the thing should sort (e.g. `MoteOverhead` for floating debris above pawns), then never modify y at runtime.
- Avoid `category=Item` for visual-only things — `Thing.TrueCenter` for Items routes through `ItemCenterAt`, which scans the cell's thing list and switches to a multi-item layout if anything else briefly shares the cell. Use `Projectile` or `Ethereal` instead.

```csharp
protected override void DrawAt(Vector3 drawLoc, bool flip = false)
{
    float lift = 0.6f + Mathf.Sin(bobPhase) * 0.18f;
    float drift = Mathf.Sin(bobPhase * 0.7f) * 0.12f;
    Vector3 loc = new Vector3(drawLoc.x + drift, drawLoc.y, drawLoc.z + lift);
    Graphic.Draw(loc, flip ? Rotation.Opposite : Rotation, this);
}
```

*Why it's tricky:* In 3D-engine intuition, "Y is up". RimWorld's `def.Altitude`, `AltitudeLayer`, and `ToVector3ShiftedWithAltitude` all bake into Y — which reinforces the wrong mental model. The Y-bob looks correct in code until you actually play it and see the flicker; the cause (depth-sort flipping the rock past Pawn/MoteOverhead/Blueprint layers) is invisible in source. `Skyfaller.GetDrawPositionAndRotation` is the in-engine confirmation: skyfallers fall via `zPositionCurve`, not Y.

## TryAttachFire silently no-ops on non-pawns; use FireUtility.TryStartFireIn instead

`Thing.TryAttachFire(fireSize, instigator)` calls `CanEverAttachFire()` which **requires `ThingCategory.Pawn`**. On any non-pawn (item, plant, building) it silently returns void with no log message — your code looks fine, the item just never catches fire.

To set fire to an item or plant, spawn a *free-standing* Fire on its cell:
```csharp
FireUtility.TryStartFireIn(item.Position, item.Map, fireSize, instigator);
```
The Fire's vanilla `DoComplexCalcs` then iterates `ThingsListAt(Position)` and damages every flammable Thing on the cell. `TryStartFireIn` is idempotent — it returns 0 chance if a Fire is already on the cell, so calling it every tick is safe.

*Why it's tricky:* The extension method name and signature look generic ("attach fire to any Thing"), and the silent-failure makes it look like the item is just "fire-resistant". The category check is buried inside `CanEverAttachFire`, which is itself called only from inside `TryAttachFire`. Easy to miss without reading the source.

## WorldObject uses ID not loadID; PlanetTile.tileId not .TileID

When subclassing `WorldObject` (e.g. a custom world-map entity like FactionArmy), the unique-id field is **`public int ID = -1`**, not `loadID`. Use `obj.ID = nextId++` and key any dictionaries by `obj.ID`. The matching `WorldObjectMaker.MakeWorldObject` sets `ID` from `Find.UniqueIDsManager.GetNextWorldObjectID()` — don't overwrite it if you use the maker.

`PlanetTile` is a readonly struct. Its tile index is **`public readonly int tileId`** (lowercase). `PlanetTile.TileID` does not exist. To log it: `tile.tileId`. The struct has an implicit `operator int` so `(int)tile` also works. The `Valid` property is `tile.tileId >= 0`.

*Why it's tricky:* Every other mod-side ID field uses `loadID` (Posting, FactionWar, Treaty…) so `army.loadID` feels natural but is a compile error. `PlanetTile` was renamed in 1.6 from the older plain-int `Tile` pattern, so old cookbook examples use `settlement.Tile` as a direct int — in 1.6 it's a struct.

## ThingComp.CompTickRare/CompTick won't fire unless the ThingDef sets tickerType

If your building has comps that override `CompTickRare()` or `CompTick()` and they appear to never run, the ThingDef is almost certainly missing `<tickerType>Rare</tickerType>` (or `Normal`). Default is `Never`, which means the Thing is never added to a tick list and none of its comps tick — silently. Symptoms: comp logs nothing, scans/timers don't progress, no errors.

```xml
<ThingDef ParentName="BuildingBase">
  ...
  <tickerType>Rare</tickerType>  <!-- required for CompTickRare to fire -->
  ...
</ThingDef>
```

*Why it's tricky:* there's no error or warning. The comp class loads, `PostSpawnSetup` runs, draw works — everything looks fine except the tick body. `CompPowerTrader`/`CompFlickable` happen to work because their behaviors don't depend on tick callbacks you control.

## Filth placementMask vs TerrainDef.filthAcceptanceMask — natural ground rejects Terrain-only filth

If `FilthMaker.TryMakeFilth` silently returns false on natural terrain (Sand, Soil, Grass, etc.), the issue is the mask interaction:

- Filth's `<filth><placementMask>` lists what KIND of cell it can sit on (e.g. `Terrain`, `Unnatural`).
- TerrainDef's `<filthAcceptanceMask>` lists what masks the terrain will accept. Natural terrains have `<li>Unnatural</li>`.
- A filth needs its placementMask to intersect the terrain's filthAcceptanceMask, or the placement is rejected with no error.

`<li>Terrain</li>` is for filth that sits on **built/artificial** floors. Vanilla `Filth_Dirt` is `Terrain`-only — that's why dirt only appears tracked indoors.

Two options for "I want this filth on any cell":
1. Omit `<placementMask>` entirely (what `Filth_Blood` does — works everywhere).
2. List both: `<placementMask><li>Terrain</li><li>Unnatural</li></placementMask>`.

*Why it's tricky:* `FilthMaker.TryMakeFilth` returns a bool but no diagnostic. The only way to find this is to log the rejected calls and notice they all happen on natural ground. The English word "placementMask" sounds like "place it on terrain", but `Terrain` here means *artificial terrain*, not *the ground at all*.

## weaponClasses entries must be one of 10 vanilla WeaponClassDefs — `Medieval` is NOT one

`<weaponClasses><li>X</li></weaponClasses>` on a ThingDef takes a `WeaponClassDef` defName, not a free-form tag. The vanilla set is fixed at 10: `Melee`, `MeleeBlunt`, `MeleePiercer`, `Neolithic`, `Ranged`, `LongShots`, `ShortShots`, `RangedLight`, `RangedHeavy`, `Ultratech`. Anything else throws `Could not resolve cross-reference to WeaponClassDef named <X> (wanter=weaponClasses)` at game start.

Specifically: there is NO `Medieval` WeaponClassDef. Medieval-tier melee weapons just use `Neolithic` or `MeleePiercer` and rely on `<techLevel>Medieval</techLevel>` + `<weaponTags><li>MedievalMeleeBasic</li></weaponTags>` for tier identity. Tags are free-form strings used by `PawnGroupMakers` for raid composition; classes are typed defs used by Ideology/role restrictions and weapon-style filters.

Second gotcha when fixing: XML list inheritance REPLACES by default. A child `<weaponClasses><li>Medieval</li></weaponClasses>` overrides the parent abstract's `<weaponClasses><li>MeleePiercer</li></weaponClasses>` rather than appending — so removing the bad line both clears the error AND restores the inherited `MeleePiercer`. Don't try to "merge" it back by hand.

*Why it's tricky:* "Medieval" is a meaningful tier word that shows up everywhere in the codebase (techLevel, weaponTags, faction names), so reaching for it as a weaponClass feels right. The error message names the def by string but doesn't suggest the valid set, and the attribution is `[RimWorld]` (the cross-ref resolver throws) so it doesn't look like a mod-side bug at first glance.

## When auto-placing a Cooler in a freezer wall, Rot4 controls which side gets cold — verify against Building_Cooler.TickRare

`Building_Cooler.TickRare` cools the cell at `Position + IntVec3.South.RotatedBy(Rotation)` and pushes heat to `Position + IntVec3.North.RotatedBy(Rotation)`. So the COLD side is the "south-rotated" cell and HOT exhaust is the "north-rotated" cell.

Recipe for a cooler mounted in a room's NORTH wall (interior is to the south, outside to the north): use **`Rot4.North`** (identity) → cold cell = South (interior gets cold), heat = North (vents outside). Using `Rot4.South` flips it: cold blows OUTSIDE and heat dumps INTO the freezer (the room heats up instead of cooling). General rule: the rotation that makes the *interior* coincide with `Position + South.RotatedBy(Rotation)` is the correct one; for a wall on the room's north edge that's Rot4.North, for the south edge it's Rot4.South, etc.

`PlaceWorker_Cooler.AllowsPlacing` separately requires BOTH the N and S cells be free of impassable things/blueprints — so place the cooler blueprint BEFORE the surrounding wall blueprints, and verify acceptance with `GenConstruct.CanPlaceBlueprintAt(coolerDef, cell, rot, map)` (log `.Reason` and bail if rejected, else you build an empty room shell forever).

*Why it's tricky:* "facing south so cold goes in" sounds right but is exactly backwards — the rotation names the cell the cold comes OUT of relative to the building's own facing, and RotatedBy composes with it. The only reliable way is to read `Building_Cooler.TickRare` and match the interior cell to the `South.RotatedBy(Rotation)` cell. The symptom of getting it wrong: the "freezer" slowly warms above ambient instead of dropping to the target temp, and food spoils anyway.

## Several buildings have constructionSkillPrerequisite that hard-blocks the build job — autonomous builders deadlock

Key buildings carry a `<constructionSkillPrerequisite>` that prevents the construct job from being assigned AT ALL if no colonist meets it (it's not a botch-chance thing — the job is simply never offered). Vanilla examples: **WoodFiredGenerator = 4**, **Cooler = 4**, geothermal/several power buildings = 6, some = 8. This is brutal for an AI/automation mod: a low-skill colony finishes its skill-0 buildings (walls, beds, fueled stove, research bench), then has nothing left it's *allowed* to build, so it can never earn the Construction XP to clear the gate — and if downstream content gates on `HasBuilding("WoodFiredGenerator")` (power), the entire base stalls forever.

Fix (honest-player): detect the deadlock by scanning live blueprints/frames for any `entityDefToBuild.constructionSkillPrerequisite > maxColonistConstruction`, and when found run a build-wall → `DesignationDefOf.Deconstruct` → rebuild grind on a small reserved patch (every build and every deconstruct grants Construction XP). Keep the training patch >10 tiles from base origin if you compute a "shelter rect" from nearby walls, or the temporary walls corrupt it.

*Why it's tricky:* the symptom ("nobody had the skill to finish the generator") looks like a botch loop, but it's a pre-job gate — no error, no botch, the build order just sits unbuilt with pawns idle. You won't find it in C#; it's a field on the ThingDef (`search_defs` the building and read `constructionSkillPrerequisite`).
