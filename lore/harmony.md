## Tick-driven map-scoped logic = `MapComponent`, not `GameCondition` or Harmony

Subclass `MapComponent`, override `MapComponentTick()`, and RimWorld auto-discovers it — no XML, no DefOf, no Harmony patch needed.

*Why it's tricky:* docs and examples lean toward `GameCondition` for time-bound effects and toward Harmony for "every tick do X". `MapComponent` is the right answer for "always-on while a settings toggle is true" and is the lowest-friction option.

## When patching a `Thing` base method and you need a comp, cast to `ThingWithComps` first

`Thing.GetComp<T>()` does not exist — comps live on `ThingWithComps`. In a Harmony postfix on a `Thing` base method, pattern-match before calling `TryGetComp`:

```csharp
if (!(__instance is ThingWithComps twc)) yield break;
var forbid = twc.TryGetComp<CompForbiddable>();
if (forbid == null) yield break;
```

CS1061 `'Thing' does not contain a definition for 'GetComp'` is the giveaway.

*Why it's tricky:* most tutorials show `thing.GetComp<>()` because the example is already a `ThingWithComps`. When you patch the base `Thing.GetGizmos`, the parameter type is the parent and the extension method silently doesn't apply.
