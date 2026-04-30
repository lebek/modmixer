## Start a vanilla GameCondition from your own code

```csharp
var condition = GameConditionMaker.MakeCondition(GameConditionDefOf.Aurora, durationTicks);
map.gameConditionManager.RegisterCondition(condition);
// to end early:
condition.End();
```

*Why it's tricky:* there's no `StartAurora` / `AddAurora` helper — easy to grep for one and find nothing. The two-step Maker + RegisterCondition pattern isn't obvious from the API surface.
