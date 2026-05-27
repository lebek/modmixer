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
