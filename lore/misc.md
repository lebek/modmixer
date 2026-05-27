## When you want to warp the OS cursor every frame, use GameComponent + Windows SetCursorPos P/Invoke

Use a `GameComponent` subclass (auto-discovered by RimWorld via reflection from `Game.FillComponents` — no XML needed, just a `(Game game)` constructor). Override `GameComponentUpdate()` — it runs every Unity frame while `ProgramState == Playing`.

For cursor warping on Windows, P/Invoke `user32.dll` `GetCursorPos`/`SetCursorPos`. Track a float `virtualX/Y` accumulator for sub-pixel precision so the cursor doesn't feel "stuck" at high dampening levels. Compute distance in Unity screen coords (`Input.mousePosition` vs `Camera.WorldToScreenPoint(pawn.DrawPos)`) — both are window-relative so they compare directly without any conversion.

Reference the `UnityEngine.InputLegacyModule.dll` in your csproj to get `UnityEngine.Input` — `UnityEngine.CoreModule` alone won't compile `Input.mousePosition`.

*Why it's tricky:* `0xCAA00001`-style hex literals exceed `Int32.MaxValue` and are inferred as `uint` by the compiler — `Log.ErrorOnce` takes `int`, so cast with `unchecked((int)0x…)`. Also `Input` is not in `UnityEngine.CoreModule`; missing the `InputLegacyModule` reference gives `CS0103: The name 'Input' does not exist`.

## RimWorld colonist cycling is Comma/Period — Tab opens Architect

When sending synthetic keystrokes to cycle the colonist bar, send **`,` (Comma)** for previous and **`.` (Period)** for next — these are the vanilla `PreviousColonist` / `NextColonist` `KeyBindingDef`s in `Defs/Core/Misc/KeyBindings/KeyBindings.xml`.

Do NOT use `Tab` / `Shift+Tab`. Tab is the default hotkey for the **Architect** `MainButtonDef` (`<defaultHotKey>Tab</defaultHotKey>` in `MainButtons.xml`), so any synthetic Tab opens the Architect menu instead of cycling colonists. Shift+Tab still emits Tab and triggers the same thing.

*Why it's tricky:* Many other games use Tab to cycle units, so it's a tempting first guess. RimWorld's MainButtonDef hotkeys are checked at the same dispatch layer as KeyBindingDefs, so there's no easy way to "consume" Tab before architect sees it — picking a different key is the right fix.

Win32 VK codes you'll need: `VK_OEM_COMMA = 0xBC`, `VK_OEM_PERIOD = 0xBE`.

## Right-click on map with no selection opens the Architect menu

When a mod fires synthetic right-clicks (controllers, accessibility, scripted input), expect this to spuriously open the Architect menu whenever the user has nothing selected. The shortcut lives in `RimWorld.MainTabsRoot.HandleLowPriorityShortcuts`:

```csharp
if (Find.Selector.NumSelected == 0 && Event.current.type == EventType.MouseDown && Event.current.button == 1 && !WorldRendererUtility.WorldSelected && ...)
{
    Event.current.Use();
    MainButtonDefOf.Architect.Worker.InterfaceTryActivate();
}
```

Fix: Harmony-prefix `MainTabsRoot.HandleLowPriorityShortcuts` and call `Event.current.Use()` when your synthetic right-click just fired. Map right-clicks (move orders, context menus) run earlier in `UIRoot_Play.UIRootOnGUI` via `mapUI.HandleMapClicks()`, so consuming the event in this later prefix doesn't break them.

*Why it's tricky:* The vanilla code is an *intentional* convenience shortcut and looks innocuous in isolation — you'd never grep for "architect" while debugging a stray right-click. The clue is `MainTabsRoot.HandleLowPriorityShortcuts` running near the tail of OnGUI, after map clicks.

To tie the suppression to your specific synthetic click (not every right-click), stamp `Time.frameCount` when you call `mouse_event(MOUSEEVENTF_RIGHTDOWN, ...)` and only consume the event if the prefix runs within ~3 frames of that stamp.

## When launching pip/long-running subprocesses from C#, never call ReadToEnd on both stdout and stderr

Synchronous `proc.StandardOutput.ReadToEnd()` followed by `proc.StandardError.ReadToEnd()` deadlocks the moment one pipe's OS buffer (typically 4-64 KB) fills while you're blocked reading the other. `pip install` is the canonical trigger — downloading large wheels like onnxruntime (~200 MB) writes lots of progress to stdout. If your code reads stderr first, pip blocks waiting to write more stdout, your reader blocks waiting for stderr EOF, both stuck forever. The subprocess looks "running" (PID alive, low RSS, no children) but no real work is happening.

Recipe: drain both pipes asynchronously, then block only on `WaitForExit(timeout)`.

```csharp
var stdoutSb = new StringBuilder();
var stderrSb = new StringBuilder();
proc.StartInfo.RedirectStandardOutput = true;
proc.StartInfo.RedirectStandardError = true;
proc.OutputDataReceived += (s, e) => { if (e.Data != null) lock (stdoutSb) stdoutSb.AppendLine(e.Data); };
proc.ErrorDataReceived  += (s, e) => { if (e.Data != null) lock (stderrSb) stderrSb.AppendLine(e.Data); };
proc.Start();
proc.BeginOutputReadLine();
proc.BeginErrorReadLine();
if (!proc.WaitForExit(600000)) { try { proc.Kill(); } catch {} return false; }
proc.WaitForExit(); // let async readers drain
```

*Why it's tricky:* the deadlock is invisible — no error, no timeout fires (you never reach `WaitForExit`), the process just sits there. You only see it when you check RSS/CommandLine externally. Also tempting wrong fixes: `--quiet` doesn't silence enough, `2>&1` only works in shells (PowerShell/cmd) not when `UseShellExecute=false`.

## RimWorld 1.6 API drift cheat sheet for porting from 1.5

Common 1.5→1.6 renames that produce CS0115/CS0117/CS1061 in C# mods being ported:

- `WorldComponent.FinalizeInit()` → `FinalizeInit(bool fromLoad)`. Override must take the bool, and call `base.FinalizeInit(fromLoad)`.
- `PawnLostCondition.IncappedOrKilled` removed — use `PawnLostCondition.Incapped` (it's now split from `Killed`, check both if you need both).
- `PawnLostCondition.LeftMap` renamed to `ExitedMap`.
- `Pawn_StoryTracker.adulthood` (private field) → `Adulthood` (public property). Same with `Childhood`.
- `GenLocalDate.Quadrum(...)` removed — use `GenDate.Quadrum(GenTicks.TicksAbs, 0f)` (or a real longitude). `GenLocalDate` still has `DayOfQuadrum`, `Twelfth`, `Season`, etc.
- `Pawn_HealthTracker.MakeDowned` is private — Harmony-patch it via string target, not `nameof` (see harmony topic).

*Why it's tricky:* most of these surface as "no definition" or "no override" errors that look like the type is missing, when really it's a signature/visibility change. Grep the decompiled 1.6 source for the new shape rather than trusting old tutorials.

## Synthetic right-click + custom FloatMenu produces a double menu

If your controller mod synthesizes a right-click (`mouse_event(MOUSEEVENTF_RIGHTDOWN/UP)`) on a face button AND also opens its own FloatMenu via `FloatMenuMakerMap.GetOptions` / `Find.WindowStack.Add`, you will get **two FloatMenus**: one from vanilla `Selector.HandleMapClicks` (which opens a menu at cursor on `EventType.MouseDown && button == 1` whenever `SelectedPawns.Any()`) plus yours. The synthetic OS-level click is queued and processed by Unity on the next OnGUI cycle, AFTER your handler runs, so vanilla's menu pops up "behind" yours and stays visible after the user dismisses the front one.

Fix: don't send the synthetic right-click. Generate the menu yourself via `FloatMenuMakerMap.GetOptions(selectedPawns, lookupPos, out context)` + `GetAutoTakeOption` for drafted attack auto-take (same code path vanilla uses), and add your `FloatMenuMap` (or subclass) to the WindowStack directly. The raw right-click was only ever needed to trigger vanilla's auto-take — which `GetAutoTakeOption` gives you cleanly without the double-menu race.

*Why it's tricky:* it looks like only one path is opening the menu, because your handler returns. The other menu opens on the next OnGUI tick from the queued OS event, so it appears with a one-frame delay and is easy to attribute to the user "double-tapping" or some other mod.

## When you find scribed state that no system reads, treat it as a wiring task not as cruft

During an integration audit, scribed/written-but-never-read state fields are usually NOT dead code — they're features whose feedback loop was never finished. Common pattern in growing mods: someone added a `personalEnemy` flag intending to wire it into raid weighting, shipped the write, didn't ship the read. The audit's job is to surface these and the fix is usually one-line: find a query/decision function that already reads similar state and add a single multiplier or branch using the orphan field.

Don't delete orphans on first pass — that destroys the design intent. Activate them: query a function that already exists (e.g. `ComputeRaidFactionWeight`, `ComputeRenown`, `ConsiderNewWars`) and fold the orphan in as an additive factor.

*Why it's tricky:* the author who wrote the orphan write usually had a clear intent that they forgot to finish; reading the field name + its setter context tells you what loop it was supposed to close. "personalEnemy = true after killing a colonist" obviously wants to bias future raids; "IsIsolationist" obviously wants to gate aggressive faction behavior; "TotalDrift" with a doc-comment about goodwill obviously wants to bump goodwill. Trust the field name.

## LookTargets in RimWorld is a CLASS not a struct — default(LookTargets) is null, optional params need null-check

`Verse.LookTargets` is `public class LookTargets : IExposable` (Verse/LookTargets.cs), NOT a struct. This means `default(LookTargets)` is `null` and any method that accepts `LookTargets lookTargets = default` as an optional parameter will receive `null` when callers omit it. Touching `.targets` without a null check NPEs with "Object reference not set to an instance of an object."

Recipe: any helper that takes `LookTargets` as an optional/default parameter must null-check the wrapper FIRST before touching its `.targets` field. Pattern: `bool hasTargets = lookTargets != null && lookTargets.targets != null && lookTargets.targets.Count > 0;`. If you want a non-null sentinel, callers must explicitly pass `LookTargets.Invalid` (a real instance with an empty/special targets list).

*Why it's tricky:* RimWorld has several Verse types that feel struct-like by name and usage (`GlobalTargetInfo`, `TargetInfo`, `LocalTargetInfo` — all real structs; `LookTargets` — class). When you write a letter-dispatching helper inspired by `Find.LetterStack.ReceiveLetter(label, body, def, lookTargets, faction)`, it's natural to assume the parameter is uninitialised-safe like a struct. It isn't. The default-parameter convention you'd use for a struct produces a null reference at runtime.
