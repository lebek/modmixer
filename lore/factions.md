## Hidden factions with `requiredCountAtGameStart` are NOT guaranteed at world gen — lazy-create them

For any hidden mod-defined faction (`<hidden>true</hidden>`), do not rely on `requiredCountAtGameStart` to put it on the world. The world-creation UI calls `FactionGenerator.GenerateFactionsIntoWorldLayer(layer, factions)` with an explicit factions list; inside `InitializeFactions`, when that list is non-null the loop early-returns without walking `requiredCountAtGameStart` at all. Result: in scenarios driven by that UI path (which is most of them), the faction never spawns and `Find.FactionManager.FirstFactionOfDef(MyFaction)` returns null forever.

Fix: lazy-create at every spawn site through a single helper:

```csharp
public static Faction GetOrCreateMyFaction()
{
    var f = Find.FactionManager.FirstFactionOfDef(MyDefOf.MyFaction);
    if (f != null) return f;
    FactionGenerator.CreateFactionAndAddToManager(MyDefOf.MyFaction);
    return Find.FactionManager.FirstFactionOfDef(MyDefOf.MyFaction);
}
```

Vanilla uses this same pattern in `BackCompatibility` for DLC factions (Empire, HoraxCult, Entities). The faction is persisted to the save once created.

*Why it's tricky:* the symptom is "works in vanilla scenarios, missing in custom ScenarioDefs / specific seeds" — looks like a scenario authoring bug, but the real cause is the world-gen path branching on whether a faction list was passed.

## FactionDef.styles only applies when fixedIdeo=true — randomly generated ideos silently drop your styles list

`<styles>` on a `FactionDef` is **silently ignored** unless the FactionDef ALSO declares `<fixedIdeo>true</fixedIdeo>`. Without `fixedIdeo`, the faction's ideology is built by `IdeoGenerator.GenerateIdeo` → `IdeoFoundation.Init` → `RandomizeStyles`, and `RandomizeStyles()` only pulls categories from `culture.thingStyleCategories` and each meme's `thingStyleCategories`. It never consults `parms.styles`. With `<fixedIdeo>true</fixedIdeo>`, `MakeFixedIdeo` runs instead, and it **explicitly clears** the random style categories and adds exactly the ones from `parms.styles`.

Recipe — for a custom faction that should use a particular StyleCategoryDef (e.g. a style pack you depend on):
```xml
<FactionDef ...>
  <fixedIdeo>true</fixedIdeo>   <!-- REQUIRED, or styles is dead code -->
  <styles>
    <li>YourStyleCategory</li>
  </styles>
  ...
</FactionDef>
```
After this, `pawn.Ideo.GetStyleFor(apparel.def)` and the equivalent weapon lookup in `PawnApparelGenerator.PostProcessApparel` / `PawnWeaponGenerator.TryGenerateWeaponFor` will return the styled `ThingStyleDef` for any vanilla item the style category maps.

*Why it's tricky:* vanilla `TradersGuild` (Odyssey) declares `<styles><li>Techist</li></styles>` without `<fixedIdeo>`, which strongly implies the field is wired up everywhere — it isn't. `FactionDef.styles` is also used as a filter in `IdeoUtility.CanUseIdeo` when picking *existing* ideos, but if no existing ideo matches, the fallback `GenerateIdeo` path drops the styles. The bug is invisible at load time (no errors) and only shows up as "the faction's pawns spawn with vanilla-styled gear" — easy to misdiagnose as a load-order or shader issue.
