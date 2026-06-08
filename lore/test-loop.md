## Fire incidents/conditions via dev console → "Execute incident", searching by defName

Don't wait on the storyteller during iteration — the cycle is far too slow for tuning multi-stage events. Trigger directly via dev tools.

*Why it's tricky:* the obvious test path ("start a colony, wait for the event") burns 10+ minutes per iteration. Dev console execution is instant.

## Add temporary settings buttons to test individual sounds/effects without firing the whole event

In your `Mod.DoSettingsWindowContents`, render `Widgets.ButtonText` controls that call your start/stop helpers directly. Use a `bool` flag to toggle ▶/⏹ for sustainers.

*Why it's tricky:* this separates "is the SoundDef/asset correct?" from "is the trigger logic correct?" — collapses minutes-per-attempt to seconds. Easy to skip; massive payoff.

## Live-tune numeric params via ModSettings + HorizontalSlider, read each tick from a MapComponent

Wire the value through `ModSettings`, render `Widgets.HorizontalSlider` in the settings panel, and have a `MapComponent` re-read it every tick. Settings hot-reload when the panel closes — no game restart.

*Why it's tricky:* the obvious workflow (edit code → rebuild → restart RimWorld) is slow; this loops in seconds. Discovery cost is low and applies to everything you'd want to tune.

## RimWorld test loop: check is_rimworld_running, sync, enable, launch, watch

`is_rimworld_running` → `quit_rimworld` (only if running) → `sync_to_game` → `enable_mod_in_game` → `launch_rimworld` → `watch_player_log`. Don't ask the user "is RimWorld open?" — check.

*Why it's tricky:* a launch is a no-op when RimWorld is already running, so you have to quit first when iterating — the spawned process won't reload mods. `ModsConfig.xml` is rewritten on quit, so syncing while the game is open can re-disable your mod.

## Triage Player.log errors before fixing — many are from OTHER mods

Cross-reference errors like `Could not resolve cross-reference: No Verse.ThingDef named X found` name the *target* def, not the source mod. Grep your active mod's source for that defName — if zero hits, the error belongs to another loaded mod and is noise. Tell the user explicitly ("these are from <other mod>, your mod is clean") rather than triaging them.

*Why it's tricky:* the log mixes all loaded mods together and a freshly-loaded mod easily produces a wall of unrelated XML errors that look damning at first glance. Reflex: debug the first error you see. Right reflex: grep your own source first. Wasted hours come from chasing other people's bugs.

## Dev-menu "advance time" jumps TicksGame and bypasses MakeIntervalIncidents — drive day-cadence work from GameComponentUpdate with a catch-up loop

RimWorld's dev menu "advance time by N days" / "pass time" actions call `Find.TickManager.DebugSetTicksGame(TicksGame + duration)`. This directly increments the tick counter **without running simulation**, so:

- `StorytellerComp.MakeIntervalIncidents` never fires for the skipped time.
- `GameComponent.GameComponentTick` never fires either.
- Anything you've gated on a per-tick or per-interval cadence (Profile recomputes, world simulation ticks, raid generation, daily housekeeping) **silently skips the entire skipped window.**

When a tester reports "I advanced 15 days and nothing in my mod changed," this is almost always the cause.

Fix has two parts:

1. **Drive day-cadence work from `GameComponent.GameComponentUpdate`**, not from a storyteller comp. `GameComponentUpdate` fires every Unity frame regardless of pause/tick state, so after a `DebugSetTicksGame` jump the next frame runs your check. Use a `_lastUpdateDayChecked` cache to coalesce repeated calls within the same in-game day.

2. **Refactor your `DailyTick` into a catch-up loop.** If your single-day handler increments a `LastDailyTickDay` counter and early-outs when `day == LastDailyTickDay`, a 15-day jump only fires it ONCE — losing 14 days of chance-based work (war ticks, faction-power events, modulo-N cadence windows like `day % 5 == 0`). Instead:

```csharp
public void DailyTick(GameComponent core) {
    const int Cap = 60;
    int target = WatcherHelpers.CurrentDay();
    if (LastDailyTickDay < 0) LastDailyTickDay = target - 1; // fresh save guard
    int iter = 0;
    while (LastDailyTickDay < target && iter < Cap) {
        LastDailyTickDay++;
        try { ProcessOneDay(core, LastDailyTickDay); }
        catch (Exception e) { Log.Error($"DailyTick({LastDailyTickDay}): {e}"); }
        iter++;
    }
    if (LastDailyTickDay < target) LastDailyTickDay = target;  // beyond cap, skip rest silently
}
```

The cap matters — without it, loading a 5-year-old save would lock the game for minutes replaying every day.

*Why it's tricky:* the storyteller-comp interval path is the documented place to put daily work, and it works fine for normal play. The bug only surfaces when a dev-tester (or savegame loaded after a long break) advances time non-incrementally. Your code looks correct, your save scribes correctly, and on a fresh natural-play test everything fires; but a tester who fast-forwards sees nothing.

## Debug palette pin paths are Actions\&lt;label&gt; or Actions\T: &lt;label&gt; — categories are display-only

RimWorld's debug palette (`Prefs.DebugActionsPalette`) stores actions by **path string**, looked up via `Dialog_Debug.GetNode(path)` which splits on `\` and walks `rootNode.children` by `label`. The structure is:

- `rootNode` ("Root")
  - `Actions` ← top-level menu node (label "Actions", capital A; `DebugTabMenu_Actions` creates `new DebugActionNode("Actions")`)
    - direct children: each `[DebugAction]` method becomes a node here
    - `Show more actions` (for `hideInSubMenu=true` entries)

The `category` field of `[DebugAction("MyCat", "My Action", …)]` is **display-only** — it groups actions visually but does NOT create a parent node (`node.category = attribute.category`, never part of `Path`). So a pin path of `MyCat\My Action` ALWAYS fails to resolve and triggers `Could not find node from path 'MyCat\My Action'. Removing.` (non-fatal warning from `Dialog_DevPalette`, logged when the palette is opened).

Correct path format (`DebugActionNode.Path` = `parent.Path + "\" + label`, and `Actions` is a top-level node so its Path is just `Actions`):
- Non-tool actions (`DebugActionType.Action`): `Actions\<label>` (label = the second `[DebugAction]` argument, with any `\` replaced by `/`)
- Tool actions (`DebugActionType.ToolMap` / `ToolMapForPawns` / `ToolWorld`): `Actions\T: <label>` — RimWorld auto-prepends `"T: "` in `DebugTabMenu_Actions.GenerateCacheForMethod`.
- **Dynamic submenus** (a `[DebugAction]` returning `List<DebugActionNode>`, or a `DebugActionNode` with children — e.g. vanilla `Spawn thing`): the submenu node's label gets `"..."` appended at runtime (`if (!text.EndsWith("...")) text += "...";`), leaves live under it, so the path is `Actions\<label>...\<leafLabel>` — e.g. `Actions\Spawn thing...\DA_MyWeapon` (leaf label = the `defName`). The `...` is invisible in source; miss it and the pin silently disappears.

Examples:
- `[DebugAction("X", "Highlight clusters")] actionType = Action` → `Actions\Highlight clusters`
- `[DebugAction("X", "Spawn cluster at cursor")] actionType = ToolMap` → `Actions\T: Spawn cluster at cursor`
- `[DebugAction("Spawning", "Spawn thing")]` (returns a thing list) → `Actions\Spawn thing...\<defName>`

This works for MODDED debug actions too: `Dialog_DevPalette` prunes the palette when it opens, *after* all mods and the full action tree (including mod `[DebugAction]`s, scanned in `GenerateCacheForMethod`) are built — so a correctly-formed modded path resolves fine. The common "modded pins always fail" belief is a path-format bug, not a load-timing one. (Parentheses in a label are fine too — they're matched verbatim; pins that "fail because of parens" actually failed because the path was category-prefixed instead of `Actions\…`.)

*Why it's tricky:* the `[DebugAction("category", "name", …)]` constructor reads like the category creates structure, and the menu visually groups by category. But `Path` is `parent.Path + "\" + label` where `parent` is `Actions`, never the category. The `"T: "` prefix and the submenu `"..."` are both invisible at the C# level — appended inside `GenerateCacheForMethod`. All three mean palette-pin paths almost never match what the modder typed; the action still exists in the menu and works fine, so the only signal is the warning log and "my pinned actions vanished from the palette".
