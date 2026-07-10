## Multi-select gizmos work via shared defaultLabel — let RimWorld merge

Don't try to detect multi-select up front. Just yield your `Command_Action` from `Thing.GetGizmos()` on every selected instance with the *same* `defaultLabel` — the gizmo bar dedupes by label across `Find.Selector.SelectedObjects` and runs the first one's action. Inside the action, iterate `Find.Selector.SelectedObjects` to operate on the full selection.

*Why it's tricky:* there's no "multi-select gizmo" API. The merge is implicit, label-keyed, and only documented by reading `GizmoGridDrawer`. Easy to over-engineer with custom MapComponents or a separate "bulk" entrypoint when the engine already does this for you.

## GizmoGridDrawer transforms the gizmo list (sort → group → skip) before drawing; firstGizmos is private-static

The gizmos drawn on the command bar are NOT the raw list you yield (e.g. `DesignationCategoryDef.ResolvedAllowedDesignators`, or a thing's `GetGizmos()`). `Verse.GizmoGridDrawer.DrawGizmoGrid` runs three transforms first: (1) sort by `Gizmo.Order`, (2) group via `Gizmo.GroupsWith` and pick a representative (first non-disabled, else first), (3) skip `!Visible` ones. So if you need to know which gizmo sits where — for an overlay, hit-testing, or layout math — mirror that pipeline; indexing the raw list selects the wrong gizmo and produces "empty cells".

Layout constants for the architect bar (uniform 75-px designators): `GizmoSpacing = (5, 14)`, right edge `UI.screenWidth - 147`, startX `210`, rows lay out bottom-up (`y` decreases on wrap from `(screenHeight - 35) - 14 - 75`). Width per command is `Verse.Command.GetWidth` (75 for the architect; varies for other commands).

*Why it's tricky:* `GizmoGridDrawer.firstGizmos` is a private-static list **cleared at the END of each `DrawGizmoGrid` call**, so a Harmony postfix sees it empty. Patching each `Command`/`Designator.GizmoOnGUI` override to capture rects is brittle (virtual dispatch hits each override separately). Simulating the pipeline yourself is the reliable route, and it's exact when widths are uniform.

## ChoiceLetter with custom buttons — subclass ChoiceLetter, instantiate manually, push via Find.LetterStack.ReceiveLetter

To send a letter with custom click-action buttons (instead of plain text + the default Close):

1. Subclass `ChoiceLetter` and override `IEnumerable<DiaOption> Choices` to yield your buttons. Use `Option_JumpToLocationAndPostpone`, `Option_Postpone`, `Option_Close` from the base for the usual nav buttons.
2. Override `ExposeData` to scribe any fields your buttons need (e.g. an object ID to look up at click time).
3. Instantiate the subclass directly (don't go through `LetterMaker.MakeLetter` unless you've registered a `LetterDef` with `letterClass=YourSubclass`). Set `def`, `ID`, `Label`, `Text`, `lookTargets`, `relatedFaction` manually.
4. Push via `Find.LetterStack.ReceiveLetter(letter)` — the overload that takes a `Letter` directly.

```csharp
public class ChoiceLetter_MyEvent : ChoiceLetter {
    public int myEntityId;
    public override IEnumerable<DiaOption> Choices { get {
        if (ArchivedOnly) { yield return Option_Close; yield break; }
        yield return new DiaOption("Do thing") { resolveTree = true, action = () => { /* ... */ Find.LetterStack.RemoveLetter(this); } };
        if (lookTargets.IsValid()) yield return Option_JumpToLocationAndPostpone;
        yield return Option_Postpone;
    }}
    public override void ExposeData() { base.ExposeData(); Scribe_Values.Look(ref myEntityId, "myEntityId"); }
}
// Send:
var let = new ChoiceLetter_MyEvent { myEntityId = id };
let.def = LetterDefOf.NeutralEvent; let.ID = Find.UniqueIDsManager.GetNextLetterID();
let.Label = "Title"; let.Text = "Body"; let.lookTargets = new LookTargets(thing);
Find.LetterStack.ReceiveLetter(let);
```

*Why it's tricky:* `LetterMaker.MakeLetter(def)` does `Activator.CreateInstance(def.letterClass)`, so it only works if you've defined a `LetterDef` XML pointing at your subclass. For ad-hoc letter subclasses (no XML), instantiate directly and skip the maker — but you MUST still set `def` and `ID` manually or the letter won't render. Also, button-click handlers MUST call `Find.LetterStack.RemoveLetter(this)` themselves; `resolveTree = true` alone doesn't dismiss the letter.

## FloatMenu.vanishIfMouseDistant defaults true — menus opened away from the cursor self-close in ~0.5 s

`Verse.FloatMenu.vanishIfMouseDistant` defaults to **true**. When the cursor is >95 px from the menu rect, `UpdateBaseColor()` fades `baseColor` toward transparent and then **calls `Close(doCloseSound: false)` + `Cancel()`** — the menu silently disappears within roughly half a second.

This is correct for context menus that follow the mouse (right-click → menu opens AT the cursor, so the cursor is already inside it). It breaks any FloatMenu you open *programmatically* at a position unrelated to the cursor — anchored next to a button, a focused cell, a HUD element, etc. The mouse is wherever the user last left it, so the freshly-opened menu is "mouse distant" from frame 1, fades, and closes itself.

**Symptom**: a menu you open in code appears, then fades and closes within ~half a second. No click, no MouseDown, no second open — pure timer/distance behavior in `UpdateBaseColor()`.

**Fix**: set `floatMenu.vanishIfMouseDistant = false` before adding it to the WindowStack (or in a `FloatMenu.SetInitialSizeAndPosition` postfix if you reposition there). Leave mouse-opened menus alone — they *should* vanish when the user moves away.

*Why it's tricky:* you'll search for `Close`, `TryRemove`, `MouseDown`, the FloatMenuOption.DoGUI path, and find nothing wrong. The close happens in `UpdateBaseColor()`, which sounds cosmetic. The 95-px threshold + the half-second fade hide that this is what kills the menu — read FloatMenu.cs to the bottom or you'll miss it.

## Convert local widget Rect to global GUI space with GUIToScreenPoint, not GUI.matrix

When patching `Widgets.*` postfixes to record rects for a later overlay draw, the captured `Rect` is in the **current GUI coordinate space** — local to whatever group/window is active. To draw the outline later (e.g., from a `WindowStack.WindowStackOnGUI` postfix where the global scaled GUI is active), use the **structural** offset from the currently-drawn Window:

```csharp
var window = Find.WindowStack?.currentlyDrawnWindow;
if (window != null)
{
    Rect wr = window.windowRect;
    float margin = window.Margin;
    return new Rect(local.x + wr.x + margin, local.y + wr.y + margin, local.width, local.height);
}
return local; // not inside a Window — already global GUI
```

*Why it's tricky:* `GUIUtility.GUIToScreenPoint` is **not** UIScale-safe inside RimWorld windows. `Verse.Window.WindowOnGUI` calls `GUI.Window`, which resets `GUI.matrix` to identity inside the callback (Unity 2018+). So at UIScale=2, `GUIToScreenPoint` returns pre-matrix coordinates inside windows but post-matrix screen pixels outside — there is **no single divisor** that works for both contexts at non-1x scale. The symptom is window contents (pause menu, dialogs) appearing at half-position-near-center while non-window UI (main button bar, colonist bar) lands correctly. Bypass `GUIToScreenPoint` entirely; use `window.windowRect + window.Margin`, which is set in scaled-GUI space before `GUI.Window` is invoked and is UIScale-agnostic. `Window.InnerWindowOnGUI` does `BeginGroup(rect.AtZero().ContractedBy(Margin))` before calling `DoWindowContents`, so widgets inside content are offset by `(windowRect.x + Margin, windowRect.y + Margin)`. Edge case: close buttons drawn outside the inner BeginGroup are over-offset by Margin (~15px); acceptable for debug overlays.

## Custom LetterDef letterClass must be a CONCRETE bare class name, NOT FQN, and NOT ChoiceLetter

In a `LetterDef`, the `<letterClass>` tag takes a bare class name (e.g. `DeathLetter`, `NewQuestLetter`, `ChoiceLetter_RansomDemand`) — RimWorld looks it up by short name across loaded assemblies. Two traps:

1. **No namespace prefix.** Writing `<letterClass>RimWorld.ChoiceLetter</letterClass>` (or `Verse.ChoiceLetter`) fails with `Could not find a type named RimWorld.ChoiceLetter`.
2. **`ChoiceLetter` is abstract.** Even with the right name, plain `ChoiceLetter` can't be instantiated. Use a concrete subclass (`ChoiceLetter_RansomDemand`, `NewQuestLetter`, `DeathLetter`) or omit the tag entirely — vanilla's `ThreatBig` LetterDef doesn't set `letterClass` at all and falls through to the default `Letter` class, which is fine for "fire-and-forget" critical letters.

*Why it's tricky:* the tag looks like every other class-pointer XML tag (`<thingClass>`, `<workerClass>`, etc.) which DO take FQN. LetterDef uniquely strips the namespace and ignores the prefix, then complains it can't find your prefixed type.

## Detect if a scroll bar is active in Widgets.BeginScrollView by comparing viewRect.height to outRect.height

In a `Widgets.BeginScrollView` Prefix patch, check `viewRect.height > outRect.height` to determine if the content overflows the visible area and a scroll bar is rendered. No need to check mouse position or hunt for the scroll bar rect — content overflow is the only condition that matters.

This is useful for input interception: to drive a scroll view programmatically, patch `BeginScrollView`, check for overflow, and write your delta straight into `ref scrollPosition`. RimWorld renders the scroll bar internally from the position value, so updating it propagates automatically.

*Why it's tricky:* early attempts often check mouse position over the scroll bar rect, but the bar is drawn *inside* the method you're patching, so its rect coordinates are hard to predict. The content-height comparison is robust regardless of mouse position or scroll bar visibility.

## DiaOption's GUI method is OptOnGUI, not DoGUI (and DiaOption.text is protected)

Two common mistakes when patching `Verse.DiaOption` (used in `Dialog_NodeTree` choices like Letters and confirmation dialogs):

1. The GUI method is **`public float OptOnGUI(Rect rect, bool active = true)`** — NOT `DoGUI`. `DoGUI` is the signature for `FloatMenuOption.DoGUI`; the two often get conflated in cookbooks.

2. `DiaOption.text` is `protected string` — you cannot read it directly from a Harmony patch. Use `HarmonyLib.Traverse.Create(__instance).Field("text").GetValue<string>()`.

```csharp
[HarmonyPatch(typeof(DiaOption), "OptOnGUI")]
static void Postfix(DiaOption __instance, Rect rect)
{
    string label = null;
    try { label = Traverse.Create(__instance).Field("text").GetValue<string>(); } catch { }
    // ...
}
```

*Why it's tricky:* Harmony's `[HarmonyPatch(typeof(T), "DoGUI")]` won't throw if `DoGUI` doesn't exist on `T` — it just silently fails to attach (or your TargetMethod returns null and the patch class is skipped). The mistake is invisible unless you have PatchGuard warnings or read the actual class.

## Don't mutate state from DoWindowContents postfixes - OnGUI runs multiple passes per frame

Harmony Postfix patches on `Window.DoWindowContents` (or any vanilla `MainTabWindow.DoWindowContents` override) fire **multiple times per frame** — once each for `EventType.Layout`, `EventType.Repaint`, plus any `MouseMove` / `MouseDown` / `KeyDown` events Unity processed that tick. If your postfix MUTATES persistent state (a cached rect, a counter, an offset), each pass applies the mutation again and you get cumulative drift. The first frame might look fine, but after a few frames the state is off by Npasses × delta.

Concrete bug I hit: I shifted a tooltip's anchor rect by `headerHeight - scrollPosition.y` inside a `Patch_MainTabWindow_PawnTable_DrawAssignTooltip.Postfix` to convert scroll-content space to window-local space. Worked once per frame in theory; in practice the postfix ran 3+ times per frame, the rect's y kept growing, and after a couple seconds DrawBelow's "flip above if off-screen-bottom" clamp pinned the tooltip at the screen's top edge — completely detached from the focused cell.

Fix: do the mutation EXACTLY ONCE per frame, in a place that's guaranteed to be called once. Good candidates:
- A `Tick()` method called from `GameComponent.GameComponentUpdate` (runs once per frame, in Update phase, before OnGUI).
- Guard a frame counter inside the postfix: `if (Time.frameCount != _lastShiftFrame) { …; _lastShiftFrame = Time.frameCount; }`.
- Make the postfix idempotent — read the source rect each call and compute the shifted rect from it, instead of mutating in place.

The Update-phase Tick is the cleanest: read `cachedHeaderHeight` and `scrollPosition` (both are plain fields on `PawnTable`, safe to read outside OnGUI) and apply the shift before calling `DpadTooltipHelper.Tick(key, anchor)`. The postfix then just calls `Draw()` without touching state.

*Why it's tricky:* If you test by tabbing to one cell and looking, the first frame looks correct. The drift compounds over many frames so the broken state only appears after some seconds, or after switching tabs and coming back. Easy to convince yourself the fix worked when it actually only worked once. Always read OnGUI patches with "this runs multiple times per frame" in mind — drawing-only operations are idempotent so it doesn't matter, but state mutation must be deduped.

## For mod windows you want on the vanilla bottom button bar, author MainButtonDefs with a MainTabWindow wrapper — don't inherit MainTabWindow on your real window

The cleanest path for "add my window to the bottom button bar" is: (1) author a `MainButtonDef` with `<iconPath>`, `<order>`, `<tabWindowClass>` pointing at a thin wrapper class, `<validWithoutMap>true</validWithoutMap>`, `<minimized>True</minimized>`; (2) write the wrapper as `MainTabWindow_X : MainTabWindow` whose only job is to delegate `DoWindowContents` to the real `Window` subclass via composition. Keep the real window as a plain `Window` so it stays draggable, has its own doCloseX, and can also be opened independently (e.g. from a different button).

Recipe: `MainTabWindow.def` is set by `MainButtonDef.TabWindow` getter via `Activator.CreateInstance`, so the wrapper must have a parameterless ctor. Override `RequestedTabSize` to forward to the inner window's `InitialSize`. Override `SetInitialSizeAndPosition` to centre horizontally + bottom-anchor vertically — vanilla's default `Left`/`Right` anchor shoves wide custom windows flush against one screen edge. Set `doCloseX = true` and `draggable = true` in the wrapper ctor because `MainTabWindow`'s base ctor explicitly sets `doCloseX = false`.

For order placement before vanilla Menu (order=500), use 480-490. Factions is order=90; everything between 90 and 500 sits in the middle of the bar.

Icon path is relative to any active mod's Textures/ folder. Vanilla uses `UI/Buttons/MainButtons/X`; you can use `UI/MainButtons/X` to keep your assets clearly namespaced. 128×128 white-silhouette PNGs render fine — RimWorld scales-to-fit the button slot.

*Why it's tricky:* changing your real window's inheritance to `MainTabWindow` directly breaks `doCloseX`, can break drag behaviour, and ties window lifecycle to a button's open/close state — opening from elsewhere becomes inconsistent. The wrapper-pattern is one extra small class but keeps every existing entry-point working.

## Persist mod state with a GameComponent — name the static accessor Instance, not Current (Current shadows Verse.Current)

To persist mod state across save/load (a queue, favorites, per-map config), use a `GameComponent` — it lives in the save graph and is auto-`ExposeData`'d:

```csharp
public class GameComponent_X : GameComponent {
    List<MyDef> _items = new List<MyDef>();
    public GameComponent_X(Game game) { }   // required ctor signature

    public override void ExposeData() {
        base.ExposeData();
        Scribe_Collections.Look(ref _items, "myItems", LookMode.Def);
        if (Scribe.mode == LoadSaveMode.PostLoadInit && _items == null)
            _items = new List<MyDef>();
    }

    // Static accessor — convenience for the rest of the mod.
    public static GameComponent_X Instance
        => Verse.Current.Game?.GetComponent<GameComponent_X>();
}
```

**CRITICAL**: name the static accessor `Instance`, NOT `Current`. The vanilla idiom reaches the live game via `Verse.Current.Game`, but if your own static property is also named `Current`, the compiler resolves the symbol-local `Current` first and emits:

```
error CS1061: 'GameComponent_X' does not contain a definition for 'Game'
```

— a misleading error that looks like a missing `using` directive but is actually scope shadowing. `Verse.Current.Game` works fully-qualified, but renaming your accessor to `Instance` avoids the trap entirely.

**Auto-reacting to vanilla state changes**: if your component should react to a vanilla event (e.g. advance a queue when the active research finishes), Harmony-Postfix the vanilla state-change method, **wrapped in try/catch** so a bug in your reaction can't brick vanilla progression:

```csharp
[HarmonyPatch(typeof(ResearchManager), nameof(ResearchManager.FinishProject))]
static class Patch_FinishProject_AutoAdvance {
    static void Postfix() {
        try {
            // read GameComponent_X.Instance, advance your own state
        }
        catch {
            // never break vanilla progression
        }
    }
}
```

The try/catch is non-negotiable for anything mission-critical to the game (research/work progression): a NullRef in your reaction would otherwise deadlock the player's tech tree forever.

*Why it's tricky:* `GameComponent` is the right abstraction (lives in the save graph, auto-`ExposeData`'d), but the `static Current` pattern most modders copy from `Verse.Current` collides with itself in the same class, and the compiler error points at the wrong cause.

## For variable-height panel content, wrap the body in BeginGroup and gate every line on remaining height

When you're laying out a Tier-3 info panel (or any panel where the body content is variable-height and the panel size depends on UI scale / resolution), two patterns together make the layout bulletproof:

**1. Wrap the body in `Widgets.BeginGroup(bodyRect)`** so anything you accidentally draw past `body.height` is silently clipped instead of spilling into the footer area or onto the shell backdrop below.

```csharp
Widgets.BeginGroup(body);
try { DrawBodyContent(pawn, body.height); }
finally { Widgets.EndGroup(); }
```

Inside the group you draw in body-local coords (`y` starts at 0).

**2. Gate every content block on `y + lineH <= h`** before drawing — including the portrait, the name line, every divider, every label. So when the panel is too short for everything, content truncates **from the bottom up** in a predictable order:

```csharp
float y = 0f;
if (y + portraitSize <= h) { /* draw portrait */ y += portraitSize + gap; }
if (y + nameH <= h)        { /* draw name */    y += nameH + gap; }
if (y + modeH <= h)        { /* draw mode */    y += modeH + gap; }
// ... description fills `h - y` if there's any left
```

The combination guarantees the visual layout is correct on every UI-scale / resolution, even when something unexpected (shorter panel, longer text after localization) would otherwise overflow.

*Why it's tricky:* without the BeginGroup, a single forgotten bounds check paints text past the body bottom — and because the footer rect is drawn separately at a fixed Y, the overflowing body text appears OVER the footer or even on the translucent shell backdrop outside the panel entirely. You can spend a lot of time hunting for "why does my panel have a smaller black area than I computed?" when the real bug is the body content painting past its bounds, not the panel being too small.

## In 1.6, add right-click options via a `FloatMenuOptionProvider` subclass — don't Harmony-patch `AddHumanlikeOrders`

RimWorld 1.6 replaced the old `FloatMenuMakerMap.AddHumanlikeOrders` (huge monolithic method that legacy guides tell you to transpile) with `FloatMenuOptionProvider`. `FloatMenuMakerMap.Init()` calls `typeof(FloatMenuOptionProvider).AllSubclassesNonAbstract()` and instantiates every concrete subclass — zero registration. Override:

```csharp
public class FloatMenuOptionProvider_Foo : FloatMenuOptionProvider
{
    protected override bool Drafted => true;    // works when drafted
    protected override bool Undrafted => true;
    protected override bool Multiselect => false;
    protected override bool RequiresManipulation => true;

    protected override FloatMenuOption GetSingleOptionFor(Thing clickedThing, FloatMenuContext context)
    {
        // return null if not your case; the provider system will skip you
    }
}
```

For a player-driven order, return a `FloatMenuOption(label, () => { var job = JobMaker.MakeJob(MyDefOf.MyJob, target); context.FirstSelectedPawn.jobs.TryTakeOrderedJob(job, JobTag.Misc); })` and wrap with `FloatMenuUtility.DecoratePrioritizedTask(...)` for the Shift-click prioritize behavior.

*Why it's tricky:* old tutorials and decompiled examples on the internet still show the `[HarmonyPatch(typeof(FloatMenuMakerMap), "AddHumanlikeOrders")]` pattern. That method still exists but the providers come first and cleanly slot into reach/reservation/manipulation gates that you'd otherwise reimplement.

## Inspector pane: open/close/highlight a specific ITab programmatically

To programmatically open a pawn-info / inspector tab on the currently-selected thing, call `RimWorld.InspectPaneUtility.OpenTab(typeof(ITab_Pawn_Needs))`. To collapse the open tab without deselecting, cast `MainButtonDefOf.Inspect.TabWindow` to `IInspectPane` and call `pane.CloseOpenTab()`. To check whether any tab is open, test `(MainButtonDefOf.Inspect.TabWindow as IInspectPane)?.OpenTabType != null`. The tab list lives on `pane.CurTabs` (`IEnumerable<InspectTabBase>`, sometimes also `IList`). The class names don't perfectly match the labels — "Bio" is `ITab_Pawn_Character`. Other relevant ones: `ITab_Pawn_Health`, `ITab_Pawn_Needs`, `ITab_Pawn_Social`, `ITab_Pawn_Gear`, `ITab_Pawn_Log`.

To draw your own indicator on the open tab, postfix-patch the **private** `RimWorld.InspectPaneUtility.DoTabs(IInspectPane pane)` (Harmony patches private methods by name). Replicate its layout: `tabsTopY = pane.PaneTopY - 30f`, then iterate `pane.CurTabs` and draw a 72×30 rect at `curTabX = InspectPaneUtility.PaneWidthFor(pane) - 72f` decreasing by 72 per visible non-Hidden tab; the open one is `t.GetType() == pane.OpenTabType`. ExtraOnGUI calls DoTabs outside any BeginGroup, so the rects are screen coordinates.

*Why it's tricky:* The tab labels and the C# class names diverge ("Bio" vs `ITab_Pawn_Character`), and there's no public draw hook for individual tabs — only the private `DoTabs` helper. Skipping `!IsVisible` AND `Hidden` items is required, otherwise the rect math drifts.

## Never call Widgets/GUI from GameComponentUpdate or input-handler code — runaway "GUI functions from inside OnGUI" cascade

`GameComponent.GameComponentUpdate` (and anything it calls, e.g. controller-input handlers) runs in Unity's Update phase, NOT OnGUI. Any call into `Widgets.*`, `GUI.*`, or `Event.current` from there throws `System.ArgumentException: You can only call GUI functions from inside OnGUI.` and the exception fires every single frame the offending code path runs — easily 1000+ errors in seconds.

Recipe: keep `Update`-phase code purely state-only (mutate fields, read input). To actually draw, defer to a Postfix on a widget that vanilla *already* renders during `DoWindowContents` — that Postfix runs inside OnGUI, so `Widgets.DrawBox`, `GUI.color`, `Event.current` all work there. Cache the "what to draw" decision on the Update-side helper, then have the Postfix query it.

*Why it's tricky:* `Event.current?.type == EventType.Repaint` returns `null` cleanly outside OnGUI so a null-check looks safe, but the moment you actually call any `Widgets.DrawBox`/`GUI.color`/etc., Unity throws. The cascade is silent in dev unless you watch Player.log — it doesn't visually fail.

## Never hardcode Tiny-font pixel heights — the 'Use tiny text' accessibility setting changes them

RimWorld's Options > Accessibility has a **"Use tiny text in some UIs"** toggle. When the user has it OFF, `GameFont.Tiny` renders noticeably taller (closer to Small), so any rect sized with a hardcoded 12 / 14 px will **clip the bottom of labels** and **truncate longer labels mid-string** ("HEALTH" → "HEAL").

Recipe: measure at runtime after setting the font.
```csharp
Text.Font = GameFont.Tiny;
float lineH = Mathf.Ceil(Text.LineHeight) + 2f;        // for label/value rect HEIGHT
float colW  = Mathf.Ceil(Text.CalcSize("HEALTH").x) + 8f;  // for column WIDTH
```
Cache these once per frame (e.g. `UpdateAdvisorTextMetrics()` at the top of your Draw method), then use the cached values for all rects and layout-dependent reservations (PortraitSizeFor, headerBlock, etc.).

*Why it's tricky:* the user's setting silently swaps the font implementation, and most modders only test with their own setting (usually default = tiny ON). The bug never appears for you, only your players. Same applies to `GameFont.Small` if the user has UI scale > 1.0 — measuring is always correct, hardcoding never is.

## Never write `y += Helper(ref y, ...)` when the helper mutates y via ref — C# overwrites the increment

When you have a Listing-style helper that advances a flowing `y` cursor via `ref float y` AND also returns a value, NEVER call it as `y += Helper(width, ref y, ...);`. C# evaluates the LHS `y` first (snapshotting the original value), then runs the call (which mutates y by ref), then assigns `originalY + returnValue` back to y — completely overwriting the ref-mutation. Net effect: every advance gets thrown away, all your sections stack at y=0, and the visible symptom is wildly overlapping section headers / labels / cards in the rendered panel.

Recipe: either have the helper advance y by ref AND return void (then call it bare: `Helper(width, ref y, ...);`), or have it return the height and let the caller add it (then drop the ref parameter). Don't mix both.

*Why it's tricky:* it compiles cleanly, the helper looks correct in isolation, and the bug is invisible until you actually render the panel — at which point it presents as a layout issue that looks like a sub-label wrapping problem or a scroll-view clipping problem, not an arithmetic problem.

## Postfixing InspectPaneUtility.InspectPaneOnGUI draws in window-local coords, not screen-absolute

A Harmony `Postfix` on `InspectPaneUtility.InspectPaneOnGUI` runs inside the owning window's `GUI.Window` group (it's invoked from `MainTabWindow_Inspect.DoWindowContents`, which Verse.Window.InnerWindowOnGUI calls inside `GUI.Window(ID, windowRect, …)` + its own `BeginGroup(rect3)`). So when you `GUI.DrawTexture` / `Widgets.DrawBox` in the postfix, the origin (0,0) is the window's top-left, NOT the screen. Using screen-absolute coordinates like `UI.screenHeight - 192` puts your draw far below the window's clip region and you see nothing.

To highlight the InfoCard "i" button (drawn by `MainTabWindow_Inspect.DoInspectPaneButtons` at local-to-inner-group `(rect.width - 48, 0, 24, 24)` where the inner group starts at `(12, 8)` after `inRect.ContractedBy(12)` + `rect.yMin -= 4`), use window-local `(paneWidth - 60, 8, 24, 24)`.

*Why it's tricky:* `GUI.Window` callbacks are coord-translated, and the existing patch site for the InfoCard close button (`Window.WindowOnGUI` postfix) DOES run in screen space because it fires after `GUI.Window` returns — so mirroring that pattern naively at InspectPaneOnGUI silently fails. The Unity GUI silently clips draws outside the active group instead of erroring, so the bug is invisible without a "why isn't my highlight showing" investigation.

## RimWorld's GenCollection.Count<T>(List<T>, Predicate<T>) shadows System.Linq.Enumerable.Count() — use fully-qualified System.Linq.Enumerable.Count(seq) on IEnumerable returns

Vanilla RimWorld defines a `GenCollection.Count<T>(this List<T>, Predicate<T>)` extension method (and similar Predicate-typed overloads). When `using System.Linq;` AND `using Verse;` are both active in a file, the compiler picks the shadowing `GenCollection.Count` over `System.Linq.Enumerable.Count()` and demands a `Predicate<T>` argument:

```
error CS7036: There is no argument given that corresponds to the required
              parameter 'predicate' of 'GenCollection.Count<T>(List<T>, Predicate<T>)'
```

The error message says `List<T>` but you may have called it on `IEnumerable<T>` (e.g. `DesignationManager.SpawnedDesignationsOfDef(...)` which returns `IEnumerable<Designation>`). C# extension-method resolution prefers the more-specific extension when in scope, and `using Verse;` brings `GenCollection` into scope.

**Fix**: call `System.Linq.Enumerable.Count` explicitly as a static method, not an extension:

```csharp
// BREAKS — picks Verse.GenCollection.Count, demands Predicate
int n = map.designationManager.SpawnedDesignationsOfDef(DesignationDefOf.Mine).Count();

// WORKS — explicit static call to System.Linq's Count(IEnumerable<T>)
int n = System.Linq.Enumerable.Count(
    map.designationManager.SpawnedDesignationsOfDef(DesignationDefOf.Mine));
```

Alternatives that also work:
- Wrap in `.ToList().Count` (allocates a list — avoid in hot paths)
- Add a manual `foreach` loop counter (zero alloc, slightly more code)
- `int i = 0; foreach (var _ in seq) i++;`

*Why it's tricky:* extension-method shadowing is invisible at the call site. `seq.Count()` looks like idiomatic LINQ; the compiler error sounds like a missing `using` directive. The actual collision lives in `Verse.GenCollection` which you can't easily inspect from your code. After you've hit this once you recognise the pattern; before then you might spend 10 minutes searching imports.

## Text.LineHeight is the cap height (W with no descender), NOT the full rendered text height

RimWorld's `Verse.Text.LineHeight` is initialized as `CalcHeight("W", 999f)` — a capital W with no descenders. So `LineHeight` is the **cap height**, not the height needed to render a string that contains 'p', 'y', 'g', 'j', 'q'.

If you size a `Widgets.Label` rect to `Text.LineHeight` and the label text contains descenders, Unity silently clips the bottom 2–6 pixels. Looks like the letters got "shaved off" at the baseline.

Fix: use `Text.CalcHeight(actualString, width)` at draw time, ceiling'd to an int pixel:

```csharp
Text.Font = GameFont.Tiny;
string label = "Auto priorities"; // has 'p' descenders
float h = Mathf.Ceil(Text.CalcHeight(label, rectWidth));
Widgets.Label(new Rect(x, y, rectWidth, h), label);
```

If you need a height value up-front (for layout budgeting before draw time), use safe upper bounds: **22 for Tiny, 24 for Small, 30 for Medium** — each gives 4 px of descender clearance over `LineHeight` (18 / 22 / 28).

*Why it's tricky:* `Text.LineHeight` reads exactly like "the line height in pixels" — the trap is that RimWorld computed it from "W" specifically. The clipping is silent: no log, no exception, just slightly chopped letters that look like a rendering glitch.

## Vanilla RimWorld 1.6 reserves F10 (TakeScreenshot) and F11 (ToggleScreenshotMode); F1-F9 and F12 are free

When picking F-key hotkeys for mod windows, the only two F-keys vanilla RimWorld 1.6 reserves are F10 (TakeScreenshot) and F11 (ToggleScreenshotMode), both defined in Core/Defs/Misc/KeyBindings/KeyBindings.xml. F1–F9 and F12 are all free for mod use by default.

Recipe: bind player-facing windows to adjacent F-keys for muscle memory (e.g. F7/F8/F9 cluster), keep dev/debug bindings on F12 (separated from player UIs by the F10/F11 vanilla screenshot keys, making a natural divide). Always set `<category>` to your own KeyBindingCategoryDef and add `<checkForConflicts>` to flag overlaps in the player's Keyboard settings panel.

*Why it's tricky:* RimWorld's vanilla KeyBindings.xml mostly uses letters (W/S/A/D/G/T/Z/B/H/Y/N/J/U/M/K/I/L/O/P/V/F/R/C/X/Q/E) — almost every letter is taken. F-keys feel "always free" but F10/F11 are silent traps because nothing in the in-game keybinding UI obviously highlights the screenshot bindings on first glance, and the collision means pressing F10 takes a screenshot AND opens your panel simultaneously without any error.

## When a Listing_Standard widget is missing inside Widgets.BeginScrollView, the viewRect height is shorter than your content

`Widgets.BeginScrollView(outRect, ref scrollPos, viewRect)` treats `viewRect.height` as the **total** scrollable content area. Anything you draw past that Y position is silently clipped — not scrollable, just gone. The label might render but the slider directly below it can vanish if the slider's Y falls past `viewRect.height`.

Pattern that works: count your sections (each `Header` ≈ 60px including the GapLine; each `CheckboxLabeled` ≈ 28; each `Label` ≈ 24; each `Slider` ≈ 22; plus your explicit `Gap()` calls) and pick a `viewRect.height` comfortably above that. For a 7-section settings panel ~1100–1300px is realistic. Set it generously — empty scroll area at the bottom is invisible, but clipped sliders are user-facing bugs.

*Why it's tricky:* the label often renders fine because it sits just before the clip line, while the slider one row below crosses the boundary. The visible symptom is "I can see the label and value, but there's no slider" — easy to mistake for a wiring bug in the slider call itself when it's actually a scroll-view sizing bug. Always update `viewRect.height` when you add a new section.

## Converting Camera.WorldToScreenPoint to GUI/windowRect space: flip Y, then divide by UIScale

`WindowStack.GetWindowAt` and `Window.windowRect` are in GUI space: `(0,0)` top-left, y increases downward, in GUI units (`screen pixels / Prefs.UIScale`). `Camera.WorldToScreenPoint` returns y-from-**bottom** in screen pixels. To test a world position against a window rect (or place a UI element over a world point), convert:

```csharp
float uiScale = Prefs.UIScale;
Vector2 pUI = new Vector2(s3.x / uiScale, (Screen.height - s3.y) / uiScale);
if (Find.WindowStack.GetWindowAt(pUI) != null) { /* a window covers this point */ }
```

`UI.MousePositionOnUIInverted` (used by CameraDriver) is in this same space — despite the name "Inverted", it produces the **standard** GUI y-from-top coordinate that windowRect uses. `Event.current.mousePosition` is y-from-bottom (matching `Input.mousePosition`), NOT y-from-top as the Unity IMGUI docs sometimes imply.

*Why it's tricky:* the name "Inverted" suggests the unusual direction, but it's the one windowRects are stored in. Using `s3.y / uiScale` (y-from-bottom) instead of `(Screen.height - s3.y) / uiScale` silently fails — `GetWindowAt` returns null for every position even when a window clearly covers the point.

## When generating gradient textures for IMGUI, RimWorld renders texture-Y=0 at the BOTTOM of the rect (no Y-flip)

When you build a small runtime `Texture2D` for a vertical gradient and use `GUI.DrawTexture(rect, tex)` to stretch it, the mapping in RimWorld's IMGUI is:

- `tex.SetPixel(0, 0, ...)` → BOTTOM of the rect on screen
- `tex.SetPixel(0, height-1, ...)` → TOP of the rect on screen

Even though Unity IMGUI uses Y-down screen coords (rect.y = top), it does NOT flip the texture during sampling — Unity's standard Y-up texture convention wins. So a "top of shell" alpha goes at the highest texture-Y, and "bottom of shell" alpha goes at texture-Y=0.

Recipe:
```csharp
for (int y = 0; y < H; y++)
{
    float t = H == 1 ? 0f : (float)y / (H - 1);  // y=0 → t=0, y=H-1 → t=1
    float alpha = Mathf.Lerp(BottomAlpha, TopAlpha, t); // y=0 → BottomAlpha
    tex.SetPixel(0, y, new Color(0, 0, 0, alpha));
}
tex.Apply();
```

`FilterMode.Bilinear` + `WrapMode.Clamp` gives a smooth gradient across any rect height in a single GUI.DrawTexture call — no banding, no per-strip alpha steps.

*Why it's tricky:* The instinct from screen-space code is "y=0 is the top, so texture pixel 0 must be the top". That's wrong here — and the failure mode is visually obvious (gradient inverted) so it's a 1-iteration fix, but only after you've burned a build cycle deploying the wrong direction. Pin the convention so the second time you generate a gradient you don't repeat the experiment.

## When reading FloatMenuOption.tooltip, access .Value.text not .Value directly

`FloatMenuOption.tooltip` is declared as `public TipSignal? tooltip`. When unwrapping the nullable, access `tooltip.Value.text` to get the string — `TipSignal` itself does not implicitly convert to `string` (it only has implicit conversions *from* string/TaggedString). Attempting `tooltip = __instance.tooltip.Value` produces CS0029 "Cannot implicitly convert type 'Verse.TipSignal' to 'string'".

*Why it's tricky:* `TipSignal` has `implicit operator TipSignal(string)` and `implicit operator TipSignal(TaggedString)`, but no reverse conversion. The struct's `.text` field is the actual string payload.

## When replacing a vanilla full-window draw, gizmos drawn inside DoWindowContents are clipped by Window.InnerWindowOnGUI's nested groups — draw from a Window.WindowOnGUI Postfix instead

`Window.InnerWindowOnGUI` wraps `DoWindowContents` in TWO nested GUI groups:

1. The outer `GUI.Window` call → translates `GUI.matrix` to put `(0,0)` at the window's top-left.
2. An inner `windowDrawing.BeginGroup(rect3)` where `rect3 = windowRect.AtZero().ContractedBy(Margin)` → adds a Margin translation AND a scissor clip rect.

Anything drawn inside `DoWindowContents` using screen-absolute coords (e.g. `GizmoGridDrawer.DrawGizmoGrid` which hardcodes `y = UI.screenHeight - 124`) lands at `(windowY + Margin) + screenY`, which is far below the window. Setting `GUI.matrix = Matrix4x4.Scale(...)` undoes the **translation** but does NOT undo the **clip rect** from `BeginGroup` — so the draw still gets scissored away.

**Recipe for "draw X on top of the shell using screen-absolute coords"**: don't fight it from inside `DoWindowContents`. Use a Postfix on `Window.WindowOnGUI`:

```csharp
[HarmonyPatch(typeof(Window), nameof(Window.WindowOnGUI))]
static class MyPostDrawPatch
{
    static void Postfix(Window __instance)
    {
        if (!(__instance is MyTargetWindow w)) return;
        // Outside both groups + clip. Screen-absolute coords work.
        MyDrawer.Draw(w);
    }
}
```

`Window.WindowOnGUI` is the public entry point that calls `GUI.Window(..., innerWindowOnGUICached, ...)`. The Postfix fires AFTER `GUI.Window` returns, which is outside both nested groups. Bonus: it also runs AFTER `DoWindowContents` finished, so anything you draw here visually layers ON TOP of the shell that `DoWindowContents` produced.

*Why it's tricky:* You'd think `GUI.matrix = identity-scale` solves it (and it does undo the translation, so debug logging shows the coords looking "right"), but the BeginGroup clip is invisible until you actually try to draw outside its bounds. Symptom is "nothing renders at all" with no log error, which feels like the draw call itself isn't firing — but it is, the pixels are just being scissored at the framebuffer level. `Find.WindowStack.ImmediateWindow` has the same problem (it's just another `GUI.Window` with its own group). The WindowOnGUI Postfix is the cleanest escape hatch.

Also: in Tier 3 of the Architect redesign, we needed `doWindowBackground = false` on the window in addition to the Postfix draw, because vanilla's `DrawWindowBackground` (called from InnerWindowOnGUI BEFORE DoWindowContents) was opaque and would have covered any earlier draw. With the Postfix-after-WindowOnGUI approach, that's not strictly needed for z-order anymore — but it's still useful aesthetically to let the map show through.

## When suppressing gizmo hotkey label text, don't touch GizmoGridDrawer.drawnHotKeys in a Prefix

To suppress only the *visual* hotkey label on a gizmo without killing keyboard input: let vanilla's `Command.GizmoOnGUIInt` run fully (key press + `drawnHotKeys.Add` all happen normally), then in a **Postfix** overdraw the label area with the button background texture using `GUI.BeginGroup(labelRect)` + `GenUI.DrawTextureWithMaterial(new Rect(-offsetX, -offsetY, butRect.width, butRect.height), Command.BGTex, mat)` + `GUI.EndGroup()`. Unity's immediate-mode GUI composites in draw order within a frame, so the user only ever sees the final overdrawn result.

*Why it's tricky*: Adding the hotkey's `KeyCode` to `GizmoGridDrawer.drawnHotKeys` in a Prefix (the "obvious" way to suppress the label) pre-blocks vanilla's `if (keyCode != KeyCode.None && !drawnHotKeys.Contains(keyCode))` check — which contains **both** `Widgets.Label` (visual) **and** `hotKey.KeyDownEvent` (the actual key-press handler). The result: all gizmo keyboard hotkeys stop working entirely. Track via `__state` in the Prefix whether the gizmo *would* draw a label (keyCode not None, not already in drawnHotKeys), then erase in the Postfix.

## When you draw text with Widgets.Label, the rect height MUST match the font's natural line height

`Widgets.Label(rect, text)` clips the rendered text to `rect.height`. If you pass a rect shorter than the font's natural line height, descenders and lowercase bottoms get sliced off — and it's not obvious from a glance, you just see "the bottom half of 'Auto priorities' is missing".

Safe minimums for RimWorld fonts:
- `GameFont.Tiny` → 18 px
- `GameFont.Small` → 22 px
- `GameFont.Medium` → 28 px

For a one-line label, use these as `rect.height`. Going smaller to "save vertical space" in a tight panel layout is a false economy — you save 4 px and lose the bottom of every label. If you really need to compress, switch to a smaller font (Tiny instead of Small), don't shrink the rect.

*Why it's tricky:* the clipping is silent — no Player.log warning, no exception, no rendered hint. The text just disappears from the rect's bottom edge. Easy to mistake for "the panel is too short" and waste time hunting for layout bugs elsewhere.

## Faction info in different UI surfaces comes from different methods — patch the right one for the surface you want

RimWorld renders faction info in several distinct UI surfaces, each pulling from a different method. Patching the wrong method = your text only shows in places the player doesn't look. There is no single "faction info" entry point.

The map (1.6):

| UI surface | What the player does | Vanilla method to patch |
|---|---|---|
| **World-map settlement click → inspect pane** (bottom of screen) | Click any settlement on the world map | `Settlement.GetInspectString()` (`RimWorld.Planet.Settlement`) — override of `WorldObject.GetInspectString` |
| **Comms console negotiation dialog header** | Right-click comms → call a faction | `Faction.GetInfoText()` — only called from `Dialog_Negotiation` |
| **Info card (right-click → "Show info")** | Right-click faction → Show info | `Faction.GetReportText` (property, get-only) — feeds `StatsReportUtility` |
| **Factions tab (gear menu)** | Open the Factions tab in the World view | `FactionUIUtility.DoWindowContents` — composes its own layout; no single "info text" call |

Verify with `search_source` before patching: `\.GetInfoText\(\)` and `\.GetInspectString\(\)` show exact call sites. `Faction.GetInfoText` has exactly one caller (`Dialog_Negotiation`); patching it for "anywhere the player looks at a faction" is a common mistake.

*Why it's tricky:* the names suggest interchangeability. `GetInfoText` sounds like "the info you see when you look at a faction." It's not — it's *one specific call site's* info. The world-map settlement click hits a totally different method living on `Settlement`, not on `Faction`. Patch BOTH (and `GetReportText` for the info card) if you want consistent agenda/stability/etc. visibility across all faction-looking surfaces.

## Section-helper functions taking y by value silently overlap their body callback

When you write a "draw section header then body" helper that advances a `float y` cursor, take `y` by `ref`. If you take it by value, and the body argument is a lambda that closes over the caller's outer `y` (typical when the body is `() => DrawFoo(rect, ref y)`), the helper's local-y advances for the header but the body still reads/writes the *outer* y — so the body draws at the outer y (one step behind the header), and the helper's return value of "header_y + header_height + body_y_delta + gap" doesn't match where content actually ended. Visual symptom: section title text appears UNDER content lines (you see "OCKS" peeking out from behind icons because "UNL" is hidden), and subsequent sections start at the wrong height.

*Why it's tricky:* the code compiles and runs without errors, the layout calls return sane-looking values, but the section header and section body silently target slightly different y variables. Refactor: change the signature to `static void DrawSection(Rect inner, ref float y, string title, Action body, float gap)` and let body mutate the same ref-y. The closure compiles identically — the only change is who owns the variable.

## When iterating QuestManager.QuestsListForReading filter out grammar-failed quests

Vanilla quest generation can leave a `Quest` in a half-baked state when its `QuestNode_X` throws — `q.description.Resolve()` then returns a string starting with `"ERR:"` containing raw `[placeholder]` tokens (`[settlement_label]`, `[RequestedThingCount]`, etc.) instead of resolved grammar. Filter these out at iteration time:

```csharp
static bool IsMalformedQuest(Quest q) {
    if (q == null) return true;
    string desc; try { desc = q.description.Resolve(); } catch { return true; }
    if (string.IsNullOrWhiteSpace(desc)) return true;
    if (desc.StartsWith("ERR:", System.StringComparison.Ordinal)) return true;
    return false;
}
```

*Why it's tricky:* Displaying these quests shows the user gibberish text, AND iterating through them tends to cascade `Error while processing a quest signal: NullReferenceException` and `Error in QuestPart cleanup: NullReferenceException` because their `QuestPart`s reference null fields. One filter solves both the display issue and gets your mod off the attribution list for those cascade NREs. Common in quicktest maps that boot before factions are fully baked (`QuestNode_TradeRequest_RandomOfferDuration` NRE, `Grammar unresolvable. Root 'questDescription'`).

## When re-skinning a vanilla menu that builds its option list inline, patch the renderer helper not the outer method

When vanilla draws a menu that builds options inline then hands them to a small renderer (e.g. `MainMenuDrawer.DoMainMenuControls` → `OptionListingUtility.DrawOptionListing`), DON'T Prefix-skip the outer method and replicate vanilla's option-building logic. Instead:

1. Set a flag in a Prefix/Postfix around the outer method (`_inDoMainMenuControls`).
2. Prefix the renderer helper (`DrawOptionListing(rect, optList)`), check the flag, divert to your themed renderer, set `__result` to the same return type as vanilla, return false to skip vanilla draw.

Vanilla keeps building the list with all its conditional entries (Save vs Load vs ReviewScenario based on `ProgramState`, DevQuickTest gated on `Prefs.DevMode`, permadeath flow gated on `Current.Game.Info.permadeathMode`, etc), so you stay robust as Ludeon adds new options across patches.

*Why it's tricky:* Replicating the option-list-building branches works initially but rots fast — every Ludeon patch that adds a main-menu entry breaks your version. Hooking at the renderer instead means the option list is whatever vanilla wants it to be. Also covers BOTH `MainMenuDrawer.MainMenuOnGUI` (title screen, Entry) AND `MainTabWindow_Menu.DoWindowContents` (in-game ESC menu) automatically since both call into `DoMainMenuControls` → `DrawOptionListing` — one patch, two surfaces.

## Widgets.HorizontalSlider mutates its own rect.y before drawing — capture the rect in a Prefix if you patch it

`Verse.Widgets.HorizontalSlider` mutates its `rect` parameter at the **top** of the method, before drawing:

```csharp
if (middleAlignment || !label.NullOrEmpty())
    rect.y += Mathf.Round((rect.height - 10f) / 2f);   // ~+10px on a 30px row
```

`Listing_Standard.SliderLabeled` always passes `middleAlignment: true`. So a Harmony **Postfix** that reads `rect` (to record the slider's position for an overlay, a highlight, hit-testing, click-sim, etc.) captures the already-shifted Y and lands ~10 px low — over the gap or the next row. Every other widget (`CheckboxLabeled`, `ButtonText`) records its rect untouched, so the bug stays invisible until a slider shares a list with other widgets (e.g. RimWorld's Graphics options tab mixes a slider in with checkboxes).

Fix: capture the original rect in a Prefix and use it in the Postfix:

```csharp
static void Prefix(Rect rect, out Rect __state) { __state = rect; }
static void Postfix(Rect __state, ...) { /* position off __state, not the postfix rect */ }
```

*Why it's tricky:* the mutation is invisible at the call site, and a Postfix is the natural place to read a final rect — for every other widget it's correct. You end up chasing coordinate-transform red herrings instead of the parameter mutation.

## WorkTags.LabelTranslated() only maps a SINGLE flag — split combined values or it logs every frame

`WorkTags.LabelTranslated()` (Verse.WorkTypeDefsUtility) is a `switch` over individual `WorkTags` enum values. Passing a COMBINED flag value (e.g. a pawn's `CombinedDisabledWorkTags`, which is usually multiple flags OR'd together) hits the `default` branch and calls `Log.Error("Unknown or mixed worktags for naming: " + (int)tags)`. In a per-frame draw (an inspector tab, a HUD), that's thousands of identical errors (×2010 in one test run).

Recipe: never call `LabelTranslated()` on a combined value. Split first:
```csharp
var labels = disabled.GetAllSelectedItems<WorkTags>()
    .Where(t => t != WorkTags.None)
    .Select(t => t.LabelTranslated());
string text = string.Join(", ", labels).CapitalizeFirst();
```
Vanilla's `CharacterCardUtility` does exactly this via its private `WorkTagsFrom` iterator + per-tag `LabelTranslated()` — it never labels the combined value directly.

*Why it's tricky:* a single-disabled-tag pawn works fine (the switch matches), so it only repros on pawns with 2+ disabled work tags — easy to miss until a test pawn happens to have a multi-tag incapability, then the log explodes.

## 1.4 → 1.6 TimeAssignmentSelector grid became a horizontal row, not 2×2

When patching `TimeAssignmentSelector.DrawTimeAssignmentSelectorGrid` to inject a new TimeAssignmentDef button (e.g. a "Worship" or "Pray" schedule), the rect-stepping math is fragile and version-sensitive:

- **1.4** drew a 2×2 grid: (0,0)Anything (1,0)Work / (0,1)Joy (1,1)Sleep, with Meditate at (2,0) if Royalty active.
- **1.5/1.6** draw a single horizontal row: (0,0)Anything (1,0)Work (2,0)Joy (3,0)Sleep [(4,0)Meditate].

A patch authored for 1.4 that walks "0,0 → 1,0 → 0,1 → 1,1 → 2,0 → 3,0" lands at horizontal slot 3 in 1.6 — i.e. on top of the Sleep button. Symptom: the modded label silently replaces Sleep visually (and clicks select the modded assignment), but the actual TimeAssignmentDef.Sleep still exists and still ticks correctly in the timetable grid below — it's a pure draw-order shadow.

Recipe for 1.6:
```csharp
rect.yMax -= 2f;
Rect rect2 = rect;
rect2.xMax = rect2.center.x;   // button width = parent.width / 2
rect2.yMax = rect2.center.y;
// (0,0) Anything
rect2.x += rect2.width;        // (1,0) Work
rect2.x += rect2.width;        // (2,0) Joy
rect2.x += rect2.width;        // (3,0) Sleep
if (ModsConfig.RoyaltyActive) rect2.x += rect2.width;  // (4,0) Meditate
rect2.x += rect2.width;        // our slot
// invoke DrawTimeAssignmentSelectorFor(rect2, MyAssignmentDef)
```

*Why it's tricky:* the rect's `width` is half the parent — buttons span TWICE the rect.width passed to the public method (the rect is 191px in vanilla but the buttons march off to x≈480 with Royalty). That looks broken but is intentional in vanilla — the schedule window has plenty of horizontal room. Don't try to "fix" the math by clamping inside the rect.

## LongEventHandler.ExecuteWhenFinished is NOT a safe background→main-thread marshal

To run Unity/main-thread work (Texture2D ctor, EncodeToPNG, Scribe, Messages) from a background thread (ThreadPool/`new Thread`), do NOT use `LongEventHandler.ExecuteWhenFinished(action)`. When no long event is in progress (at the menu or in-game), it executes the action **inline on the calling thread**, so your "main-thread" code runs off-thread and Unity HARD-CRASHES the process (no managed exception — a native crash dump with `UnityEngine.Texture2D:Internal_CreateImpl` near the top of the Mono stack, and the bridge only shows a benign `"Type X probably needs a StaticConstructorOnStartup attribute … assets must be loaded in the main thread"` warning).

Reliable pattern: enqueue actions into a `static Queue<Action>` (lock-guarded) and drain them from a method guaranteed to run on the main thread every frame — e.g. a Harmony Postfix on `UIRoot_Play.UIRootOnGUI` / `UIRoot_Entry.UIRootOnGUI` calling a `DrainMainQueue()`. OnGUI runs on the Unity main thread for both the menu and in-game.

*Why it's tricky:* `ExecuteWhenFinished` works correctly when called *during* game load (a long event is active, so it defers) — which is exactly when most prewarm/init code runs — so the same call site looks fine until something triggers it from a worker while idle (e.g. a mod-options button kicking off a background pipeline).

## Menu, gizmo, and command labels use sentence case — not Title Case

RimWorld UI text is sentence case: `"Set target fuel level"`, `"Copy settings"`, `"Allow"`, `"Draft"` — first word (and proper nouns) capitalized, nothing else. This applies to `Command`/`Gizmo` `defaultLabel`, `FloatMenuOption` text, `Designator` labels, `ITab`/`MainTabWindow` labels, settings rows, and button captions. Def `<label>` values go one step further — they're fully lowercase (`"wooden table"`, `"steel"`) and RimWorld auto-capitalizes them at display sites via `.CapitalizeFirst()`.

*Why it's tricky:* Title Case ("Set Target Fuel Level") reads as "polished" and is an LLM's default, but it visibly clashes with vanilla and every other mod's UI — one of the fastest tells of an amateur mod. Match vanilla's casing exactly; don't Title-Case.
