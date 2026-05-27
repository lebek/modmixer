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
