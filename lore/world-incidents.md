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

## Faction leader death must be detected by patching Notify_LeaderDied, NOT by polling — vanilla auto-replaces the leader immediately

When you want to react to a faction leader's death (succession crisis, civil war, refugee waves, anything), the obvious "check `faction.leader == null` or `faction.leader.Dead` every slow tick" approach **does not work**.

Why: `Faction.Notify_LeaderDied()` is called immediately when the leader pawn dies (from `Faction.Notify_MemberDied`, which fires from `Pawn.Kill` → `Pawn_HealthTracker.MakeDead`). The very first line inside `Notify_LeaderDied` calls `TryGenerateNewLeader()` synchronously, which sets `faction.leader` to a freshly-generated pawn. By the time *any* slow tick fires (even one tick later), the leader is replaced — `leader != null` and `!leader.Dead`. Your detection logic always sees "no death happened."

**The right hook is a Harmony prefix on `Faction.Notify_LeaderDied`:**

```csharp
[HarmonyPatch(typeof(Faction), nameof(Faction.Notify_LeaderDied))]
public static class Patch_Faction_Notify_LeaderDied
{
    public static void Prefix(Faction __instance)
    {
        // __instance.leader is still the DYING pawn here; capture it if you need their name/data
        var dyingLeader = __instance.leader;
        // ... your reaction (fire event, send letter, update state) ...
    }
}
```

Return `true` (or don't return anything) to let vanilla continue: vanilla still calls `TryGenerateNewLeader` and sends its own "X has died, Y is now leader" letter. Your hook is the *interactive layer* (e.g., a ChoiceLetter offering pretenders) on top of vanilla's default behaviour.

If you want to suppress vanilla's letter entirely, you can return `false` from the prefix, but you'll also skip the `QuestUtility.SendQuestTargetSignals("NoLongerFactionLeader", ...)` calls vanilla makes — those signals matter for any quest that tagged the dying leader. Safer to let vanilla run and accept the dual-letter UX.

Related: `Faction.Notify_LeaderLost()` (line ~926 in Faction.cs) is similar but fires when a leader is *captured* or otherwise removed without dying. Patch both if your reaction covers both transitions.

*Why it's tricky:* the natural mental model is "I'll check on a tick — leaders rarely die, no big deal." But vanilla's synchronous regen means the *window where leader is null/dead is zero ticks long*. The dev action `kill the leader → wait → check` fails 100% of the time even though you can see "X has died" in the vanilla log. Symptom of the trap: your slow tick logs say nothing, the leader name in the inspect pane changed silently, and you assume the kill didn't register.
