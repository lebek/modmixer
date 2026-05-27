## Start a vanilla GameCondition from your own code

```csharp
var condition = GameConditionMaker.MakeCondition(GameConditionDefOf.Aurora, durationTicks);
map.gameConditionManager.RegisterCondition(condition);
// to end early:
condition.End();
```

*Why it's tricky:* there's no `StartAurora` / `AddAurora` helper — easy to grep for one and find nothing. The two-step Maker + RegisterCondition pattern isn't obvious from the API surface.

## When checking for active sieges in C#, use LordJob_Siege not LordJob_SiegeCity

The correct class is `RimWorld.LordJob_Siege` (inherits `LordJob`). `LordJob_SiegeCity` does not exist and will produce CS0246. Check `foreach (var lord in map.lordManager.lords) if (lord.LordJob is LordJob_Siege)` to detect siege lords.

*Why it's tricky*: vanilla Wiki and AI completions often suggest "SiegeCity" as it sounds more specific, but the actual class in Assembly-CSharp is just `LordJob_Siege`.
