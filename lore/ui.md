## Multi-select gizmos work via shared defaultLabel — let RimWorld merge

Don't try to detect multi-select up front. Just yield your `Command_Action` from `Thing.GetGizmos()` on every selected instance with the *same* `defaultLabel` — the gizmo bar dedupes by label across `Find.Selector.SelectedObjects` and runs the first one's action. Inside the action, iterate `Find.Selector.SelectedObjects` to operate on the full selection.

*Why it's tricky:* there's no "multi-select gizmo" API. The merge is implicit, label-keyed, and only documented by reading `GizmoGridDrawer`. Easy to over-engineer with custom MapComponents or a separate "bulk" entrypoint when the engine already does this for you.

## After opening a context menu / picker for the focused cell, call DpadTooltipHelper.SuppressUntilFocusChanges()

When the user presses A on a controller-focused cell that opens a context menu (FloatMenu picker, sub-dialog, color picker, etc.), the tooltip on that focused cell becomes both redundant and visually noisy: the tooltip is still drawing (e.g. "Baldwin — Medical care. A: pick care level") while the picker is already open on top of it. Vanilla never has this problem because mouse-driven menus open AT the cursor and the cursor moves into the menu — but D-pad-driven menus open ANCHORED to the focused cell, leaving the tooltip stranded.

**Fix** (encoded in `DpadTooltipHelper`):
- Helper tracks an internal `_suppressedKey` field.
- `SuppressUntilFocusChanges()` snaps `_suppressedKey = _lastKey` and also clears `_show` so the tip vanishes this frame.
- `Tick()` auto-clears `_suppressedKey` when the focus key changes (the user D-pads to a different cell → re-engage tooltip).
- `Draw()` early-returns when `_suppressedKey == _lastKey`.

**Call site recipe** — in your A-press handler, after opening the picker:

```csharp
case Zone.Cells:
    if (IsDropdownColumn(col)) {
        FloatMenuAnchor.Set(_focusedCellRect);
        OpenDropdownMenu(pawn, col);
        SoundDefOf.Tick_High.PlayOneShotOnCamera();
        TooltipHelper.SuppressUntilFocusChanges();   // ← add this line
    }
    break;
```

That's it — no per-key tracking, no scheduling. The suppression is keyed to the focus key the helper already maintains, so it auto-engages and auto-disengages as the user navigates.

*Why it's tricky:* you'd assume `IsTopmostUsable<TWindow>` returning false (because the picker is on top) would stop your Tick from running and naturally stop tooltip draws. It mostly does — but the picker draws ABOVE your tab's tooltip, and your tab's `DoWindowContents` Postfix still runs (a `MainTabWindow` keeps rendering behind any FloatMenu). The Postfix drew the tooltip last frame (before the picker opened) and continues drawing it this frame because the focus state hasn't changed. You need explicit per-key suppression that survives "your Tick stops running" gracefully.

## Architect gizmo grid: simulate the layout, do not index ResolvedAllowedDesignators directly

When building D-pad / controller nav for the architect's gizmo grid, the displayed list is NOT `def.ResolvedAllowedDesignators`. `Verse.GizmoGridDrawer.DrawGizmoGrid` does three transforms before drawing: (1) sort by `Gizmo.Order`, (2) group via `Gizmo.GroupsWith` and pick a representative (first non-disabled, else first), (3) skip `!Visible` ones. Indexing the raw list produces "empty cells" in the grid and selects the wrong designator. Mirror the same pipeline yourself — all architect designators are 75 px wide (`Verse.Command.GetWidth`), `GizmoSpacing = (5, 14)`, right edge is `UI.screenWidth - 147`, startX is `210`, and rows lay out bottom-up (`y` decreases on wrap from `(screenHeight - 35) - 14 - 75`).

*Why it's tricky:* `GizmoGridDrawer.firstGizmos` is a private static list that's cleared at the END of each `DrawGizmoGrid` call, so a Harmony postfix sees it empty. Patching every `Command/Designator/Designator_Build/Designator_Dropdown.GizmoOnGUI` override to capture rects is brittle (Harmony virtual dispatch hits each override separately). The simulation is exact for the architect because designator widths are uniform.

## Center controller icons next to centered button text by measuring the translated label

When drawing a controller button icon (e.g., A.png) next to the text label of a vanilla `Widgets.ButtonText` button, position the icon immediately to the left of the text rather than at the button's left edge:

1. Get the exact translated string vanilla uses (e.g., `"ManageApparelPolicies".Translate()`).
2. Measure it: `float textWidth = Text.CalcSize(label).x;`
3. Compute centered group: `float groupStartX = rect.x + (rect.width - iconSize - gap - textWidth) / 2f;`
4. Draw icon at `groupStartX`.

Vanilla already centers the text, so the icon lands exactly to its left and the combined group stays centered. Clamp the icon to `rect.x + 4f` / `rect.xMax - 4f - iconSize` to prevent clipping on very narrow buttons.

*Why it's tricky:* The obvious approach of `rect.x + 4f` puts the icon at the far left, which looks disconnected from centered button text. Measuring the label is required because the text width varies by language and translation.

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

## Click-sim systems MUST be one-shot per frame or checkbox toggles silently no-op (Unity OnGUI fires multiple event passes per frame)

Unity's IMGUI runs MULTIPLE event passes per frame: Layout, MouseDown, MouseUp, MouseMove, KeyDown, KeyUp, Repaint, etc. **Each pass re-calls every widget's draw code** — `Widgets.Checkbox` is called once per pass, `Widgets.ButtonInvisibleDraggable` is called once per pass, etc.

If you have a click-sim system that says "fake `__result = true` when my pending click rect matches", and the system is NOT one-shot, then:

1. Tick fires A press → `RequestClick(rect)` sets `_frame = currentFrame`
2. Same frame Layout pass: vanilla `Widgets.Checkbox(rect)` → `ToggleInvisibleDraggable(rect)` → `ButtonInvisibleDraggable(rect)` → your Prefix sees `ShouldClick(rect) == true` → returns `Pressed` → `ToggleInvisibleDraggable` toggles the bool
3. Same frame Repaint pass: same chain → `ShouldClick(rect)` STILL returns true → toggles the bool AGAIN
4. Net result: **even number of toggles = no net change**, user sees "A didn't toggle the checkbox"

This silently breaks toggles, checkboxes, and any other widget where the action runs IN the click handler (vs. opening a separate window which would noticeably appear twice).

Fix: make `ShouldClick(rect)` invalidate `_frame` after the first successful match. Mirror `UniversalButtonNavHelper.ShouldSimulateClick`:

```csharp
public static bool ShouldClick(Rect r)
{
    if (Time.frameCount != _frame) return false;
    bool match = /* rect compare */;
    if (match) _frame = -1;  // ONE-SHOT
    return match;
}
```

Apply this to ANY click-sim helper you write. Lore reference for the broader pattern: `read_lore ui` → "Synthesized click-via-__result-override must be one-shot per frame, not per-frame-window" — that lesson covered ButtonText. This is the same lesson for ButtonInvisibleDraggable.

*Why it's tricky:* the click handler runs CORRECTLY the first time. The bug is the SECOND invocation reverting it. Looks identical to "the click didn't fire at all" from the user's perspective, so you go hunting for missing rect matches when the rect IS matching — just too many times.

## Cloning a Tier-3 PawnTable menu (Wildlife from Animals) — what to override, what to gate, what to mirror

When porting a second/third Tier-3 menu wrapping `MainTabWindow_PawnTable` (e.g. Wildlife built on top of Animals), you do NOT have to re-derive every constant — most of `AnimalsFullScreenNav` clones verbatim. The DIFFERENCES that matter:

**1. Window type.** Most patches gate `__instance is MainTabWindow_X`. Same trick as Assign vs Animals (both inherit `RequestedTabSize` from the base). If your new tab inherits `DoWindowContents` from the base too (Wildlife does — Animals overrides it), you patch the BASE `MainTabWindow_PawnTable.DoWindowContents` with a type-gate Prefix; if it overrides (Animals), patch the derived type directly. Always grep for `override.*DoWindowContents` in the indexed source before deciding.

**2. Pawn filter.** Each `MainTabWindow_X.Pawns` getter contains the filter (e.g. Wildlife = `p.Spawned && (p.Faction == null || p.Faction == Faction.OfInsects) && p.AnimalOrWildMan() && !p.Position.Fogged && !p.IsPrisonerInPrisonCell()`). Mirror it exactly in your `RefreshLists()` — DO NOT try to reuse vanilla's enumerable, because `MainTabWindow_PawnTable.table` rebuilds rows on its own schedule and your D-pad focus might lag a frame behind.

**3. Shell height.** Override `ComputeShellRect()` if you want a different fraction. Animals uses 50%; Wildlife uses 70% because wildlife lists tend to be much longer (every spawned wild animal). Define a local `WildlifeShellHeightFraction = 0.70f` constant — don't touch `ControllerShell.ShellHeightFraction` (other tabs depend on 1/3).

**4. Column buckets.** Re-run the Dropdown / Checkbox / ReadOnlyMetadata classification for THIS tab's specific column set. Wildlife has zero dropdowns (no Master/MedCare/Area — wild animals aren't player-owned), two checkboxes (Hunt + Tame, both `PawnColumnWorker_Designator` subclasses), several read-only stats (`ManhunterOnDamageChance`, `ManhunterOnTameFailChance`, `Predator`, `MentalState`), and one special action column: `PawnColumnWorker_Info` (24-px InfoCardButton). The Info column gets its own bucket: A press opens `Dialog_InfoCard(pawn)` directly, NO click-sim into vanilla DoCell (vanilla expects a real mouse click on the 24×24 sub-rect).

**5. Top bar.** Often shorter or absent. Wildlife has just one button ("Manage areas..."). Make sure `FocusTopBarIdx` is clamped to `0..count-1` — Animals uses `0..1` because it has two buttons; copy-pasting "Clamp(idx, 0, 1)" into a one-button menu makes D-pad-right step to a phantom button. Always clamp against `(buttons.Count - 1)`.

**6. Footer prompts.** Drop the prompts for unbound buttons. Wildlife has no LT/RT bindings (no allowed area on wild animals to cycle) so the footer row drops the "LT/RT Area" entry. Don't leave dead prompts — they suggest the user can do something they can't.

**7. Button-handler gates everywhere.** For every Animals gate (`AnimalsFullScreenNav.IsAnimalsTabOpen`) in InputCore + Patch_Camera, add a parallel Wildlife gate (`WildlifeFullScreenNav.IsWildlifeTabOpen`). 8 sites in InputCore (A/B/X/Y/Back/R3/LB modifier/avatar-shoot-safety) + 1 in Patch_Camera. Miss any and stale map-side input fires through (forbid toggles behind the menu, draft toggles, etc.).

**8. InputCore Tick route.** Add the `IsTopmostUsable` route to `HandleDpad` right after Animals, returning early so other routes don't run. The `IsTopmostUsable<MainTabWindow_Wildlife>` automatically yields to FloatMenus / Dialog_Confirm / dev palette via the `Tier3MenuRouting` predicate; no extra code needed for "menu gets focus when it opens" — `UniversalButtonNavHelper._lastSeenTopWindow` auto-acquires focus on any Dialog-layer window change.

**9. Settings + ResetToDefaults + Scribe.** Add `useFullScreenWildlife` field, default `true`, Scribe_Values entry, ResetToDefaults reset, and a settings UI block with a yellow ⚠ if `LockedByModConflict`. Each of these in their own Edit call — the four sites are far apart in Mod.cs and bunching them into one multi-edit risks a partial rollback.

*Why it's tricky:* the obvious assumption "Wildlife is just Animals with different pawns" misses the cross-cutting integration: 8 button-handler gates, Tier3 routing predicate, settings round-trip, ResetToDefaults, mod-conflict detection, Patch_Camera trigger gate. None of those live in your nav file — they live in InputCore / Mod.cs / Patch_Camera. Forgetting any one leaves a subtle bug: forbid fires behind the menu, draft toggles on background pawns, or the camera-zoom triggers double-fire with non-existent LT/RT bindings.

## Controller-anchored FloatMenus must set vanishIfMouseDistant=false or they auto-close in ~0.5 s

`Verse.FloatMenu.vanishIfMouseDistant` defaults to **true**. When the cursor is >95 px from the menu rect, `UpdateBaseColor()` fades `baseColor` toward transparent, and at >95 px **calls `Close(doCloseSound: false)` + `Cancel()`** — the menu silently disappears within roughly half a second.

This is vanilla's design for context menus that follow the mouse (right-click on a unit → menu opens AT the cursor, so the cursor is automatically inside it). It's BROKEN for D-pad / controller-driven menus that we anchor next to a focused UI cell: the user's mouse cursor is wherever they last left it (often the dev palette, the corner of the screen, somewhere completely unrelated), so the freshly-opened menu is "mouse distant" from frame 1, fades, and closes itself.

**Symptom**: A press opens a FloatMenu. The menu appears, then fades and closes within ~half a second. No click sim, no MouseDown, no extra A press — pure timer/distance behavior in vanilla's `UpdateBaseColor()`.

**Fix**: set `floatMenu.vanishIfMouseDistant = false` before adding to the WindowStack. Best place to do it: centrally in your anchor system — e.g. our `Patch_FloatMenu_SetInitialSizeAndPosition_Anchor` postfix flips the flag whenever it consumes an anchor, so every controller-driven menu inherits the fix and no per-call-site change is needed. Mouse-opened menus keep vanilla behavior (they SHOULD vanish if the user moves away).

```csharp
[HarmonyPatch(typeof(FloatMenu), "SetInitialSizeAndPosition")]
static class Patch_FloatMenu_SetInitialSizeAndPosition_Anchor {
    static void Postfix(FloatMenu __instance) {
        if (!FloatMenuAnchor.TryConsume(out var anchor)) return;
        __instance.vanishIfMouseDistant = false;   // ← critical
        // ... reposition windowRect to anchor ...
    }
}
```

*Why it's tricky:* you'll search for `Close`, `TryRemove`, `MouseDown`, the FloatMenuOption.DoGUI path, and find nothing wrong. The close happens in `UpdateBaseColor()` which sounds like a cosmetic helper. The 95-px threshold + the half-second fade animation hide that this is what kills your menu. If you don't read the bottom of FloatMenu.cs all the way through, you'll miss it. The fix is one line; the diagnosis takes hours if you don't know to look at distance/timer logic.

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

## Custom cursor pipelines should not suppress in your own full-screen menus by default

When you add a controller-stick → OS-cursor pipeline alongside D-pad navigation, the *first* instinct is to suppress the cursor inside your own full-screen menus so it doesn't fight focus highlights — that's wrong. Users want hybrid input: D-pad for big jumps + cursor for the occasional precise click on a button the D-pad route is awkward to reach. Default to letting the cursor run at your `UI_Standard` (precise but usable) speed when one of your menus is the topmost window; keep a `Suppressed` mode in the enum but reserve it for explicit modal flows that genuinely cannot coexist with a free cursor.

Watch out for one trap: if your Tier-3 menu is the *same Window subclass* as the vanilla menu it replaces (e.g. you patch `MainTabWindow_Work.DoWindowContents` rather than spawning a new Window type), a naive `w is MainTabWindow_Work` classification will treat both vanilla and Tier-3 forms identically. Gate each main-tab check on the corresponding `useFullScreen*` toggle:
```csharp
if (w is MainTabWindow_Work) return !s.useFullScreenWorkTab;  // vanilla → tiny, Tier-3 → standard
```

*Why it's tricky:* the "don't fight focus" intuition is real but solves the wrong problem — D-pad focus highlights and a freely-moving cursor coexist fine because they're different attention channels (highlight ring vs cursor sprite). Suppressing the cursor only frustrates users who specifically wanted hybrid input.

## Custom LetterDef letterClass must be a CONCRETE bare class name, NOT FQN, and NOT ChoiceLetter

In a `LetterDef`, the `<letterClass>` tag takes a bare class name (e.g. `DeathLetter`, `NewQuestLetter`, `ChoiceLetter_RansomDemand`) — RimWorld looks it up by short name across loaded assemblies. Two traps:

1. **No namespace prefix.** Writing `<letterClass>RimWorld.ChoiceLetter</letterClass>` (or `Verse.ChoiceLetter`) fails with `Could not find a type named RimWorld.ChoiceLetter`.
2. **`ChoiceLetter` is abstract.** Even with the right name, plain `ChoiceLetter` can't be instantiated. Use a concrete subclass (`ChoiceLetter_RansomDemand`, `NewQuestLetter`, `DeathLetter`) or omit the tag entirely — vanilla's `ThreatBig` LetterDef doesn't set `letterClass` at all and falls through to the default `Letter` class, which is fine for "fire-and-forget" critical letters.

*Why it's tricky:* the tag looks like every other class-pointer XML tag (`<thingClass>`, `<workerClass>`, etc.) which DO take FQN. LetterDef uniquely strips the namespace and ignores the prefix, then complains it can't find your prefixed type.

## D-pad spatial nav across dense rows: use row-clustering, not weighted-distance, or ↑↓ jumps diagonally

The naïve spatial-nav heuristic `dist = |dx| + |dy| * 3` for D-pad ↑↓ between widgets feels broken in dense rows (Dialog_Trade rows, ITab_Pawn_Gear rows, Caravan tabs): ↑↓ jumps diagonally to a button on the adjacent row whose X is closer than the same-column item, because the 3× off-axis penalty isn't enough to overcome a ~30px X difference.

Fix — "row clustering": for ↑/↓, FIRST find the nearest distinct Y band in the requested direction (with a `RowClusterEpsilonPx = 6f` tolerance to absorb sub-pixel rendering), THEN pick the item in that band whose X is closest to the current X. Symmetrically for ←/→: prefer items in the SAME row (within the same epsilon); only fall back to penalised-distance search if no same-row candidate exists.

Net effect: ↑↓ always lands on the "same column" of the next semantic row. ←→ stays in the row of widgets unless there's nothing left, then it jumps to the nearest column on the adjacent row.

*Why it's tricky:* the weighted-distance heuristic LOOKS correct in tests with sparse widgets — and it is, in that case. The failure mode only appears in dense layouts where multiple widgets share a Y band tighter than the off-axis weight can compensate for. Symptom: "D-pad ↑↓ feels random in this menu" with no error.

## Detect if a scroll bar is active in Widgets.BeginScrollView by comparing viewRect.height to outRect.height

In a `Widgets.BeginScrollView` Prefix patch, check `viewRect.height > outRect.height` to determine if the content overflows the visible area and a scroll bar is rendered. No need to check mouse position or search for the scroll bar rect — the presence of content overflow is the only condition that matters.

This is useful for input interception: if you want to apply XInput stick input to scroll bars, patch `BeginScrollView`, check for overflow, and apply your delta to `ref scrollPosition` directly. The scroll bar's visual rendering is handled by RimWorld internally; you just need to update the position value and it propagates automatically.

*Why it's tricky:* Early attempts often check mouse position over the scroll bar rect, but the scroll bar UI is drawn *inside* the method you're patching, so the rect coordinates are hard to predict. Content height comparison is more robust and fires regardless of mouse position or scroll bar visibility toggles.

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

## For Tier-3 features that need to persist with the save (queues, favorites), use GameComponent + ExposeData + name the static accessor Instance (NOT Current) to avoid shadowing Verse.Current

When a Tier-3 menu adds a new feature that needs to persist across save/load (research queue, project favorites, settings-per-map state, etc.), the right pattern is a `GameComponent`:

```csharp
public class GameComponent_X : GameComponent {
    List<MyDef> _items = new List<MyDef>();
    public GameComponent_X(Game game) { }   // required ctor signature

    public override void ExposeData() {
        base.ExposeData();
        Scribe_Collections.Look(ref _items, "controllerSupportX", LookMode.Def);
        if (Scribe.mode == LoadSaveMode.PostLoadInit && _items == null)
            _items = new List<MyDef>();
    }

    // Static accessor — convenience for the rest of the mod.
    public static GameComponent_X Instance
        => Verse.Current.Game?.GetComponent<GameComponent_X>();
}
```

**CRITICAL**: name the static accessor `Instance`, NOT `Current`. The vanilla pattern uses `Verse.Current.Game` to access the live `Game` object, but if your own static property is named `Current`, the compiler resolves the symbol-table-local `Current` first and emits:

```
error CS1061: 'GameComponent_X' does not contain a definition for 'Game'
  and no accessible extension method 'Game' accepting a first argument of
  type 'GameComponent_X' could be found
```

The error is misleading — it sounds like a missing `using` directive but it's actually scope shadowing. `Verse.Current.Game` would work fully-qualified, but it's cleaner to just rename your accessor to `Instance` and avoid the trap entirely.

**Auto-reaction patches**: if your feature should auto-react to vanilla state changes (e.g. research queue advances when the active project finishes), use a Harmony Postfix on the vanilla state-change method, **wrapped in try/catch** so a bug in your reaction doesn't brick vanilla progression:

```csharp
[HarmonyPatch(typeof(ResearchManager), nameof(ResearchManager.FinishProject))]
static class Patch_FinishProject_AutoAdvance {
    static void Postfix() {
        try {
            var rm = Find.ResearchManager;
            if (rm.GetProject() != null) return;  // vanilla already set next
            var comp = GameComponent_ResearchQueue.Instance;
            if (comp?.Count == 0) return;
            var next = comp.DequeueFirstStartable();
            if (next != null) rm.SetCurrentProject(next);
        }
        catch {
            // never break vanilla progression
        }
    }
}
```

The try/catch is non-negotiable — research/work progression is mission-critical to the game, and a NullRef in your queue-advance logic would deadlock the player's tech tree forever otherwise.

*Why it's tricky:* `GameComponent` is the right abstraction (lives in the save graph, auto-ExposeData'd) but the `static Current` pattern most modders copy from `Verse.Current` collides with itself in the same class. The compiler error is opaque ("Game" not found on YOUR type, sounds like a missing reference). Rename to `Instance` and you save 20 minutes of bewilderment.

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

## Handle the close button (B) at the TOP of Tick() — before any empty-list early-return — so empty-state screens are still escapable

Tier-3 menus typically guard their `Tick()` with a first-frame refresh + empty-list early-return:

```csharp
public static void Tick() {
    if (_pawns.Count == 0 || _table == null) {
        var win = Find.WindowStack?.WindowOfType<MainTabWindow_X>();
        if (win != null) RefreshLists(win);
        if (_pawns.Count == 0) return;   // ← TRAP
    }
    // … D-pad / A / B / X / Y handling …
}
```

This early-return happens BEFORE the B-button handler. Combined with the gate-and-handle ownership rule (InputCore's `HandleBButton` consumes B because we own the tab), the user gets stuck on the empty-state screen with no way to close: B is consumed by the gate, our Tick early-returns before the B handler, vanilla never sees the keystroke.

The empty case is hit on:
- Animals tab with zero colony animals (a brand-new game can land here)
- Wildlife with all animals fogged / on a small map
- Auto-slaughter on a map with zero configs
- Any future Tier-3 menu whose data source can legitimately be empty

**Fix**: handle B (and any other close-the-menu button) FIRST in Tick, before the empty-list early-return:

```csharp
public static void Tick() {
    // Close button works even on the empty-state screen — InputCore consumes
    // B because we own the tab, so we MUST handle it here before any
    // empty-list early-return.
    if (XInputHelper.JustPressed(XInputHelper.BTN_B)) {
        XInputHelper._bConsumedThisFrame = true;
        var w0 = Find.WindowStack?.WindowOfType<MainTabWindow_X>();
        if (w0 != null) Find.WindowStack.TryRemove(w0);
        return;
    }
    if (_pawns.Count == 0 || _table == null) { /* refresh + return */ }
    // … rest of Tick …
}
```

Apply to every Tier-3 menu. The other handlers (A / X / Y / LB / RB / D-pad) can sit after the early-return because they're meaningless on the empty-state screen.

*Why it's tricky:* the bug only surfaces when the data source happens to be empty — on most test maps Animals has at least one pawn, Wildlife has spawned animals, Auto-slaughter has configs. The empty case is rare enough that QA misses it. The fix is two lines but you have to remember to write it; the obvious gate-and-handle pattern (`gate B in InputCore → handle B in Tick body`) silently breaks here because the early-return jumps over the body.

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

## Modal dialogs with tabular data (Dialog_AutoSlaughter etc.) are Tier-3 candidates — same shell pattern, with InitialSize getter patched directly

The Tier-3 design language (LEFT info panel + scrollable matrix + footer) isn't just for MainTab windows. Any modal that displays tabular data with per-row config benefits from the same treatment. `Dialog_AutoSlaughter` is the canonical second example after the PawnTable tabs.

**Recipe — what changes from a PawnTable Tier-3 port**:

**1. InitialSize patch is simpler**: most `Dialog_X` subclasses override `InitialSize` directly (Dialog_AutoSlaughter returns `new Vector2(1050f, 600f)`), so you patch the property getter on the derived type without the base+gate trick used for `MainTabWindow_PawnTable.RequestedTabSize`:
```csharp
[HarmonyPatch(typeof(Dialog_AutoSlaughter), nameof(Dialog_AutoSlaughter.InitialSize), MethodType.Getter)]
static class Patch_X_InitialSize {
    static void Postfix(ref Vector2 __result) {
        if (!XDialogNav.IsActive) return;
        __result = new Vector2(UI.screenWidth * 0.85f, UI.screenHeight * 0.85f);
    }
}
```

**2. Suppress vanilla close-button + close-X** in a `Window.PreOpen` Postfix gated by `__instance is Dialog_X`. You draw your own footer prompts (`A · X · Y · B`) so vanilla's doCloseButton would be visual noise on top:
```csharp
[HarmonyPatch(typeof(Window), nameof(Window.PreOpen))]
static class Patch_X_PreOpen {
    static void Postfix(Window __instance) {
        if (!(__instance is Dialog_X dlg)) return;
        if (!XDialogNav.IsActive) return;
        dlg.doCloseButton = false;
        dlg.doCloseX      = false;
        XDialogNav.Reset();
    }
}
```

**3. DoWindowContents Prefix returns `false` to skip vanilla.** Use `Traverse.Create(dialog).Field("map").GetValue<Map>()` to read private fields. Re-implement count loops locally if vanilla uses private structs you can't access via Traverse (e.g. Dialog_AutoSlaughter's `AnimalCountRecord` struct is private — re-implementing the count via vanilla's public `SpawnedColonyAnimals + AutoSlaughterManager.CanEverAutoSlaughter` is ~30 lines and avoids the type-visibility wall).

**4. `Tier3MenuRouting.IsTopmostUsable<Dialog_X>(IsActive)`** is the route. The IsActive setting flag controls opt-in. The Tick fires when the dialog is on top.

**5. Same 8 InputCore gates + Patch_Camera trigger gate.** Mirror the pattern. Modal absorbs map-side input anyway via `absorbInputAroundWindow`, but the gates are needed because our handlers fire BEFORE vanilla's absorb-input check (we run in Update, vanilla absorbs in OnGUI).

**6. Stepper cells with ∞ ↔ numeric toggle**: at `∞` (sentinel = -1), LB/RB/LT/RT should **jump to current count** rather than wrapping or staying at ∞. The first nudge press "commits" to a real value matching what's already on the map; subsequent presses adjust ±1/±10. A toggles ∞↔current. This is the most predictable controller flow — every adjustment press lands on a real value the user can reason about.

```csharp
void Step(int delta) {
    int v = GetMax(cfg, col);
    int newVal = v == -1 ? current : Mathf.Max(0, v + delta);
    if (newVal != v) SetMax(cfg, col, newVal);
}
```

*Why it's tricky:* the obvious stepper math `v + delta` underflows below 0 (or wraps `-1 + 1 = 0` interpreting ∞ as -1 numerically). At ∞ the user has no anchor for what ±1 means — jumping to current count gives them one. Also, never let nav fire on read-only "Current" sub-cells: classify them as `IsReadOnlyMetadata` and skip in `StepColIdx` style, same as the PawnTable empty-cell-skip lesson. 7 group columns × 2 sub-cells = 14 visual cells but only 7 actionable; D-pad walks the 7.

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

## OptionClickSimSystem.RequestClick must use vanilla's INNER click-target sub-rect, not the outer cell rect

**THIS IS NOT OPTIONAL.** Re-shipped 2026-05-27 after the original fix silently rolled back from a multi-edit failure and the symptom recurred.

When a Tier-3 menu uses `OptionClickSimSystem.RequestClick(rect)` to fire A-press on a vanilla-drawn cell, the rect MUST be vanilla's actual click target rect, not the outer column cell rect. `OptionClickSimSystem.ShouldClick(r)` compares with 0.5-px tolerance — outer-vs-inner never matches, and A appears silently broken: you HEAR the click sound (from your Tick's `SoundDefOf.Tick_High.PlayOneShotOnCamera()`) but the checkbox doesn't toggle.

**The 24×24 inner rect pattern** appears in vanilla `PawnColumnWorker_Checkbox.DoCell`, `PawnColumnWorker_Trainable.DoCell`, and every `PawnColumnWorker_Designator` subclass (`Slaughter`, `Sterilize`, `Pregnant`, `FollowDrafted`, `FollowFieldwork`, `AnimalDig`, `AnimalForage`, `SpecialTrainable`, `ReleaseAnimalToWild`, `Bond`):

```csharp
// Vanilla pattern (DO NOT modify — your inner rect MUST match):
int num = (int)((rect.width - 24f) / 2f);
int num2 = Mathf.Max(3, 0);  // = 3
Vector2 topLeft = new Vector2(rect.x + (float)num, rect.y + (float)num2);
Rect innerRect = new Rect(topLeft.x, topLeft.y, 24f, 24f);
Widgets.Checkbox(topLeft, ref checkOn, 24f, ...);  // ← ToggleInvisibleDraggable → ButtonInvisibleDraggable(innerRect)
```

Your Tier-3 menu MUST have a helper that returns this inner rect for these column types:

```csharp
static Rect ComputeClickTargetRect(Rect cell, PawnColumnDef col) {
    switch (col?.workerClass?.Name) {
        case "PawnColumnWorker_Checkbox":
        case "PawnColumnWorker_Trainable":
        case "PawnColumnWorker_Sterile":
        case "PawnColumnWorker_Sterilize":
        case "PawnColumnWorker_Slaughter":
        case "PawnColumnWorker_Pregnant":
        case "PawnColumnWorker_FollowDrafted":
        case "PawnColumnWorker_FollowFieldwork":
        case "PawnColumnWorker_AnimalDig":
        case "PawnColumnWorker_AnimalForage":
        case "PawnColumnWorker_SpecialTrainable":
        case "PawnColumnWorker_ReleaseAnimalToWild":
            return new Rect(cell.x + (cell.width - 24f) / 2f, cell.y + 3f, 24f, 24f);
        default:
            return cell;
    }
}
```

And use it: `OptionClickSimSystem.RequestClick(ComputeClickTargetRect(_focusedCellRect, focusedCol));`

For non-checkbox columns (icons that fill the whole cell, dropdowns where you draw your own flat themed cell anyway), the outer rect is fine.

*Why it's tricky:* the FOCUS HIGHLIGHT renders on the outer cell rect (because your `DrawFocusHighlight` uses `_focusedCellRect`), so visually it looks like A should hit the whole cell. But vanilla's actual click target is the inner 24×24 widget — RequestClick on anything else silently misses. The 0.5-px tolerance in `ShouldClick` is generous enough that you might guess "close enough" and not realize you're off by 5+ pixels. Read vanilla's `DoCell` source for each column type to compute the exact inner rect.

## PawnTable D-pad nav should skip cells that vanilla renders empty for the focused pawn (HasCheckbox=false, predator=false, not-in-mental-state, etc.)

Many vanilla `PawnColumnWorker` cells render NOTHING for certain pawns:
- `PawnColumnWorker_Designator` subclasses (Hunt, Tame, Slaughter, Sterilize, Pregnant, FollowDrafted, …) early-return from `DoCell` when `HasCheckbox(pawn)` returns false. Examples: Tame is empty for insects (`TameUtility.CanTame=false`); Hunt is empty for non-flesh creatures; Slaughter / Release / Sterilize are empty for non-player-faction animals.
- `PawnColumnWorker_Predator` draws an icon only when `pawn.RaceProps.predator` is true.
- `PawnColumnWorker_MentalState` draws an icon only when `pawn.InMentalState` is true.
- `PawnColumnWorker_Bond` similar — draws only when a bond exists.
- `PawnColumnWorker_Sterile` (the read-only icon, not the designator) only draws when the animal IS sterile.

If your Tier-3 D-pad navigation steps blindly through `_visibleColumns[FocusColIdx++]`, the focus ring lands on these invisible cells. The user sees the ring sitting on empty space and has to D-pad past it to reach the next real cell — confusing and feels broken.

**Fix recipe**:
```csharp
static bool CellHasContent(Pawn pawn, PawnColumnDef col) {
    if (pawn == null || col == null) return false;
    switch (col.workerClass?.Name) {
        case "PawnColumnWorker_Hunt":
        case "PawnColumnWorker_Tame":
        case "PawnColumnWorker_Slaughter":
        case "PawnColumnWorker_Sterilize":
        case "PawnColumnWorker_ReleaseAnimalToWild":
        case "PawnColumnWorker_FollowDrafted":
        case "PawnColumnWorker_FollowFieldwork":
        case "PawnColumnWorker_AnimalDig":
        case "PawnColumnWorker_AnimalForage":
        case "PawnColumnWorker_SpecialTrainable":
            // HasCheckbox is protected — use Traverse.
            try { return Traverse.Create(col.Worker).Method("HasCheckbox", pawn).GetValue<bool>(); }
            catch { return true; }
        case "PawnColumnWorker_Predator":     return pawn.RaceProps?.predator ?? false;
        case "PawnColumnWorker_MentalState":  return pawn.InMentalState;
        // …add more as you discover them
        default: return true;
    }
}

static int StepColIdx(int current, int dir, Pawn pawn) {
    int idx = current + dir;
    while (idx >= 0 && idx < _visibleColumns.Count) {
        if (CellHasContent(pawn, _visibleColumns[idx])) return idx;
        idx += dir;
    }
    return current;
}
```

Then in `HandleDpadLeft` / `HandleDpadRight`:
```csharp
FocusColIdx = StepColIdx(FocusColIdx, -1 /* or +1 */, _pawns[FocusPawnIdx]);
```

**Also**: when moving up/down to a new pawn, the current FocusColIdx may now be empty for the new pawn. Re-anchor:
```csharp
void ReanchorColAfterRowChange() {
    var pawn = _pawns[FocusPawnIdx];
    if (CellHasContent(pawn, _visibleColumns[FocusColIdx])) return;
    int right = StepColIdx(FocusColIdx, +1, pawn);
    if (right != FocusColIdx) { FocusColIdx = right; return; }
    int left = StepColIdx(FocusColIdx, -1, pawn);
    if (left != FocusColIdx) FocusColIdx = left;
}
```
Search right first (toward the action columns user is most likely heading for), then left as fallback.

*Why it's tricky:* you don't see the problem until you test with a pawn that exhibits the empty case — insects in Wildlife, non-player-faction animals in Animals, calm pawns in any tab. Code-review alone misses it because the focused-rect highlight LOOKS correct sitting on an empty cell. The Traverse-to-protected-method trick (`Method("HasCheckbox", pawn).GetValue<bool>()`) is the cheapest way to mirror vanilla's invisible-cell logic without re-implementing every subclass's eligibility check.

## Postfixing InspectPaneUtility.InspectPaneOnGUI draws in window-local coords, not screen-absolute

A Harmony `Postfix` on `InspectPaneUtility.InspectPaneOnGUI` runs inside the owning window's `GUI.Window` group (it's invoked from `MainTabWindow_Inspect.DoWindowContents`, which Verse.Window.InnerWindowOnGUI calls inside `GUI.Window(ID, windowRect, …)` + its own `BeginGroup(rect3)`). So when you `GUI.DrawTexture` / `Widgets.DrawBox` in the postfix, the origin (0,0) is the window's top-left, NOT the screen. Using screen-absolute coordinates like `UI.screenHeight - 192` puts your draw far below the window's clip region and you see nothing.

To highlight the InfoCard "i" button (drawn by `MainTabWindow_Inspect.DoInspectPaneButtons` at local-to-inner-group `(rect.width - 48, 0, 24, 24)` where the inner group starts at `(12, 8)` after `inRect.ContractedBy(12)` + `rect.yMin -= 4`), use window-local `(paneWidth - 60, 8, 24, 24)`.

*Why it's tricky:* `GUI.Window` callbacks are coord-translated, and the existing patch site for the InfoCard close button (`Window.WindowOnGUI` postfix) DOES run in screen space because it fires after `GUI.Window` returns — so mirroring that pattern naively at InspectPaneOnGUI silently fails. The Unity GUI silently clips draws outside the active group instead of erroring, so the bug is invisible without a "why isn't my highlight showing" investigation.

## Reconcile cursor + page state BOTH before and after input each tick

When a `Tick()` handler processes D-pad input AND owns paging state (e.g. `PageTopRow` that follows the cursor), call your `ReconcilePagingAndCursor()` (or equivalent clamp/auto-page) function at BOTH ends of the tick: once at the start (handles screen-resize, category-change, anything that changed state since last tick) and once at the end after input handlers ran. Without the second call, on the frame the user presses D-pad UP/DOWN past the visible page boundary the cursor moves but `PageTopRow` lags one frame — you see a brief flash of the highlight in empty space before the page snaps to follow.

*Why it's tricky:* the cursor highlight and the gizmo render happen in `OnGUI` AFTER `Tick()` returns. If `Tick` reconciles only at the top, the input handlers later in the same tick update `GizmoRow` but `PageTopRow` doesn't catch up until next tick. One-frame visual desync.

## Redesigning vanilla Dialog_Confirm — Prefix DoWindowContents, use Widgets.ButtonInvisible for capture, rely on UnivNav auto-focus

Vanilla `Verse.Dialog_Confirm` is a tiny 280×150 brown-atlas modal used by destructive actions across the game (Tame/Slaughter confirms for non-player-faction animals, etc.). To redesign it for controller-first while keeping every entry-point and every confirmer-callback working:

**1. Resize via `SetInitialSizeAndPosition` Postfix**, not by overriding `InitialSize` (it's a get-only property — you can't change it without subclassing). Recompute windowRect after vanilla positions it:
```csharp
[HarmonyPatch(typeof(Dialog_Confirm), "SetInitialSizeAndPosition")]
static class Patch_DialogConfirm_SetInitialSizeAndPosition {
    static void Postfix(Dialog_Confirm __instance) {
        float w = Mathf.Min(480f, UI.screenWidth - 40f);
        float h = Mathf.Min(220f, UI.screenHeight - 40f);
        __instance.windowRect = new Rect((UI.screenWidth-w)/2f, (UI.screenHeight-h)/2f, w, h);
    }
}
```

**2. Prefix-replace `DoWindowContents`** returning `false` to skip vanilla. Pull the private fields (`title`, `confirm`, `onConfirm`) via `Traverse.Create(__instance).Field(...).GetValue<T>()` — vanilla makes them all private but Harmony's `Traverse` reads them anonymously.

**3. Draw your themed visuals** (opaque-black backdrop + 1-px white border + flat 55%-black buttons), then call `Widgets.ButtonInvisible(buttonRect)` for click detection. The button rect is automatically captured by your existing `Patch_Widgets_ButtonInvisible_SimClick` for UnivNav D-pad navigation + A-press click sim — you get focus indicators, D-pad walking between Cancel/Confirm, and controller activation for free.

**4. Auto-focus on open is FREE** if you've already integrated `UniversalButtonNavHelper._lastSeenTopWindow` tracking (which fires `FindStarter()` on Dialog-layer window changes). `Dialog_Confirm` has `absorbInputAroundWindow = true` + `WindowLayer.Dialog`, so it qualifies. The next `Tick` after the dialog appears picks up the first captured button rect as focus. You do NOT need any extra "ensure menu gets focus" code — the lift's already done.

**5. Preserve vanilla's keyboard Enter shortcut** (`Event.current.keyCode == KeyCode.Return`). Lots of vanilla and mod code expects Enter to confirm; keeping it costs three lines and avoids breaking muscle-memory:
```csharp
bool acceptViaKeyboard = false;
if (Event.current.type == EventType.KeyDown && (Event.current.keyCode == KeyCode.Return || Event.current.keyCode == KeyCode.KeypadEnter)) {
    acceptViaKeyboard = true;
    Event.current.Use();
}
```

**6. Confirm action wiring:**
```csharp
if (Widgets.ButtonInvisible(cancelRect))  { ...Close(); }
if (Widgets.ButtonInvisible(confirmRect) || acceptViaKeyboard) { onConfirm?.Invoke(); Close(); }
```

`Find.WindowStack.TryRemove(__instance)` to close. Vanilla `closeOnAccept = false` means we own Enter handling entirely.

*Why it's tricky:* you might assume you need to re-implement the dialog's whole click + close + onConfirm flow yourself. You don't — `Widgets.ButtonInvisible` is the chokepoint your other patches already capture for UnivNav, and `Traverse.Create(...).Field(...)` lets you call the vanilla `onConfirm` without subclassing. Most of the work is just visual polish on top of vanilla's existing input plumbing.

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

## Strip the pawn name prefix from synthesized cell tooltips — info panel already shows the name

When `GetFocusedTooltipText()` synthesizes a tooltip for a focused cell, do NOT prefix the result with `pawn.LabelShortCap`. The Tier-3 info panel already shows the pawn's name + portrait big on the left side — every focused-cell tooltip starting with "Baldwin —" or "Erika —" is visual noise that adds nothing.

```csharp
// WRONG — name is redundant with the info panel
return $"{pawn.LabelShortCap} — Medical care\n\nCurrent: {c}\n\nA: Pick care level";

// RIGHT — action-line only
return $"Medical care\n\nCurrent: {c}\n\nA: Pick care level";
```

Same rule when wrapping a vanilla-captured tooltip from `UniversalTooltipRegistry.Lookup`:

```csharp
// WRONG
if (!string.IsNullOrEmpty(captured)) return $"{pawn.LabelShortCap}\n\n{captured}";

// RIGHT
if (!string.IsNullOrEmpty(captured)) return captured;
```

And when nothing useful is available, return `""` (empty) — DO NOT fall back to `pawn.LabelShortCap`. An empty string makes the tooltip disappear; `pawn.LabelShortCap` makes it show just the animal name with no controller action info, which is pure noise.

*Why it's tricky:* the obvious default is "always include the pawn name so the user knows what they're hovering". That's true for vanilla mouse hover (where the cursor could be on any of many rows). For controller D-pad, the user just navigated TO that cell — they know which row they're on, and the info panel reinforces it. The name-prefix copy-paste survives untouched from "what tooltip would a mouse-hovering user need?" thinking into the controller flow where it's redundant.

## Synthesized click-via-__result-override must be one-shot per frame, not per-frame-window

When you Harmony-postfix a click widget (`Widgets.ButtonText`, `Widgets.ButtonInvisible`, `Widgets.RadioButton`) to set `__result = true` for a controller-A synth, gate the override on `_simFrame == Time.frameCount && rect.matches(target)` AND clear `_simFrame = -1` on the first successful match. Otherwise the override fires on EVERY OnGUI event pass (Layout, Repaint, plus any input event) in that frame, and the caller's `if (Widgets.Button…) { action }` body runs multiple times: Page.DoNext fires twice (skips a whole page), toggles flip twice (cancel out), counters increment by 2.

*Why it's tricky:* Vanilla's `GUI.Button` returns `true` only on the real MouseUp event, so the caller's branch only runs once per click. When you bypass that with a postfix override, you defeat the per-event-type gate — unless you one-shot.

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

## Tier-3 IsTopmostUsable must yield to ALL real sub-dialogs (Dialog, FloatMenu, Super), only filtering out ImmediateWindow overlays

When a Tier-3 menu opens a sub-window — `Dialog_AutoSlaughter`, `Dialog_ManageAreas`, `Dialog_RenameArea`, a vanilla picker `FloatMenu`, etc. — D-pad input MUST shift to the sub-window. Otherwise your Tier-3 `Tick()` keeps firing on every frame, intercepts D-pad, and the user can't navigate the sub-menu.

The wrong `IsTopmostUsable` impl is "no FloatMenu on top" — it correctly yields to FloatMenu pickers but misses `Dialog_*` sub-windows entirely. The other wrong impl is "no Super/Dialog window on top" — too strict; it returns false for incidental `ImmediateWindow` overlays (tooltip layers, drag previews) that sit on those layers without absorbing input, and your Tier-3 nav silently never claims input.

**The right check**: walk `Find.WindowStack`, skip your own tab + `ImmediateWindow` instances + **`Window_Dev` instances** (the dev palette and other developer tools — they sit on Dialog layer but shouldn't grab D-pad), yield (return false) if any remaining `Super`/`Dialog`-layer window exists:

```csharp
public static bool IsTopmostUsable<TWindow>(bool settingFlag) where TWindow : Window {
    if (!IsTabOpen<TWindow>(settingFlag)) return false;
    var ws = Find.WindowStack;
    if (ws == null) return false;
    for (int i = 0; i < ws.Count; i++) {
        var w = ws[i];
        if (w == null) continue;
        if (w is TWindow) continue;          // our own tab — not blocking
        if (w is ImmediateWindow) continue;  // tooltip / overlay — not input-grabbing
        if (w is Window_Dev) continue;       // dev palette / debug windows — not for player nav
        if (w.layer == WindowLayer.Super || w.layer == WindowLayer.Dialog)
            return false;                    // real sub-menu on top → yield
    }
    return true;
}
```

This is encoded in `Source/ui/Tier3MenuRouting.cs::IsTopmostUsable<T>` — use that, don't roll your own.

Then in the input chain (`InputCore.HandleDpad`), other dedicated routes claim each sub-menu's input:
- `ColorPickerNavHelper.IsActive` → owns color picker
- `ManageAreasDialogNav.IsTopmost` → owns Manage Areas dialog
- `AutoSlaughterNavHelper.IsDialogOpen` → owns auto-slaughter dialog
- `UniversalButtonNavHelper.IsActive` → owns FloatMenu pickers + any generic absorbing modal

These all sit BEFORE the LB-modifier early-return, so they get a shot at input before vanilla map handlers.

*Why it's tricky:* The wrong impls each have a defensible-looking story. "FloatMenu only" gives you working pickers and you stop debugging. "Any Super/Dialog window" gives you correct dialog yielding but breaks under any mod that overlays an ImmediateWindow on top of your menu — AND breaks during test runs because `Window_Dev` (Dialog_Debug, EditWindow, etc.) defaults to `WindowLayer.Dialog` and is always on the stack in dev mode. The `is ImmediateWindow` + `is Window_Dev` skips are both load-bearing. If a user's mod adds yet another always-on-top overlay you'll need a third skip — keep adding them as you encounter them.

## Tier-3 menus need a global AnyTier3Owning predicate so cross-cutting systems (UnivNav highlight, vanilla TipRegion) bail inside the Tier-3 matrix

When a Tier-3 menu owns input, its dedicated nav helper draws the selection highlight + controller tooltip at the focused cell. Cross-cutting systems that ALSO try to draw highlights or tooltips inside the same matrix area create double-rendering bugs:

**Double yellow selection box** — `UniversalButtonNavHelper.DrawSelectionHighlight` is called from `Patch_Widgets_ButtonInvisibleDraggable_SimClick.Postfix` for every captured button, gated on `IsSelectedAndActive(rect)`. That predicate is true when `_selectedRect` (UnivNav's last-D-pad-selected rect, possibly STALE from before the Tier-3 menu opened) matches a button inside the Tier-3 matrix. Result: the user sees one yellow box drawn by the Tier-3 nav helper AND one drawn by UnivNav, on two different cells.

**Vanilla tooltip floating in screen-center** — `PawnColumnWorker_Checkbox.DoCell` etc. call `TooltipHandler.TipRegion(rect, tip)` when `Mouse.IsOver(rect)`. If the user's mouse cursor happens to be over a matrix cell while D-pad-navigating elsewhere, vanilla draws the brown tooltip box at the mouse position. Our existing `Patch_TipRegion_SuppressVanillaWhenCustomDrawn` only suppresses *D-pad-originated* tips (`!realMouseOver && DpadFocus.IsRectFocused`), so mouse-hovered tips pass through.

**Fix — one global predicate, two consumer fixes**:

```csharp
// Tier3MenuRouting.cs
public static bool AnyTier3Owning {
    get {
        if (Current.ProgramState != ProgramState.Playing) return false;
        if (IsTabOpen<MainTabWindow_Architect>(ArchitectFullScreenNav.IsActive)) return true;
        if (IsTabOpen<MainTabWindow_Work>(WorkTabFullScreenNav.IsActive))       return true;
        // … one entry per Tier-3 menu …
        if (ManageAreasDialogNav.IsTopmost)            return true;
        if (AutoSlaughterDialogNav.IsDialogOpen)       return true;
        return false;
    }
}
```

```csharp
// UniversalButtonNavHelper.IsSelectedAndActive:
if (Tier3MenuRouting.AnyTier3Owning) return false;   // ← Tier-3 owns the highlight

// Patch_TipRegion_SuppressVanillaWhenCustomDrawn.Prefix:
if (Tier3MenuRouting.AnyTier3Owning) return false;   // ← suppress ALL vanilla TipRegion
```

Add new Tier-3 menus to `AnyTier3Owning` as they ship — it's the central inventory of "who owns input right now". Use whatever `IsTabOpen` / `IsTopmost` / `IsDialogOpen` accessor each helper already exposes; you don't need to standardize the property name across helpers.

*Why it's tricky:* the obvious gates (Tick-route early-return in HandleDpad) only prevent UnivNav.Tick from running. UnivNav's `_selectedRect` lingers from before the Tier-3 menu opened, and the Postfix-based highlight draw fires INDEPENDENTLY of Tick — every captured ButtonInvisibleDraggable runs the Postfix every Repaint. The cross-cutting fix has to gate the *consumers* (highlight + tooltip), not just the *producers* (Tick). The dev palette being open with `absorbInputAroundWindow=true` (Dialog_Debug / Dialog_OptionLister set this) is what flips `UnivNav.IsActive=true` even in test mode, exposing the bug consistently — without dev mode you might not see it until a user reports their mod's modal absorb is doing the same thing.

## Tier-3 PawnTable columns: classify columns into Dropdown / Checkbox / ReadOnlyMetadata for styling + tooltip decisions

For any Tier-3 menu wrapping a vanilla `PawnTable` (Animals/Wildlife/Assign/Work), classify every column you encounter into one of three buckets — each bucket gets different styling and tooltip handling:

**1. Dropdown columns** — picker opens a FloatMenu on A. Vanilla DoCell is SKIPPED (it draws the brown button atlas that clashes with our flat console style); we draw our own 55%-black themed cell with a left accent strip and the current value label. Examples: `PawnColumnWorker_Master`, `_MedicalCare`, `_AllowedArea`, `_AllowedAreaWide`, `_Policy<T>` subclasses (Outfit/Drug/Food/Reading).

**2. Checkbox columns** — vanilla draws a 24×24 checkbox at `(cell.x + (cell.width-24)/2, cell.y + 3)`. We paint a 55%-black backdrop BEHIND vanilla's checkbox (drop the left accent — the centered glyph would compete with it) so the cell reads as a button matching the dropdown style. A press toggles via `OptionClickSimSystem.RequestClick(ComputeClickTargetRect(cell, col))`. Examples: `PawnColumnWorker_Checkbox`, `_Trainable`, `_Sterilize`, `_Slaughter`, `_ReleaseAnimalToWild`, `_FollowDrafted`, `_FollowFieldwork`, `_AnimalDig`, `_AnimalForage`, `_SpecialTrainable`.

**3. Read-only metadata columns** — pure info, no controller action. NO backdrop (a black square behind a pure-info icon would suggest it's clickable), and `GetFocusedTooltipText()` returns empty string so no tooltip draws at all. Examples: `PawnColumnWorker_Gender`, `_Age`, `_LifeStage`, `_Pregnant`, `_MentalState`, `_Bond`, `_Sterile`-icon-when-already-sterile.

**Watch out**: `PawnColumnWorker_Sterile` (read-only icon, "this animal IS sterile") and `PawnColumnWorker_Sterilize` (designator checkbox, "designate for sterilization surgery") are TWO DIFFERENT columns. The icon column is read-only metadata; the designator is a checkbox. Same trap exists for `_ReleaseAnimalToWild` (designator → free this animal) vs `Trainable_Release` (training flag → trained to release prisoners). The label "Free" in the Animals tab refers to the designator; "Release" in the Trainable cluster refers to the training flag.

```csharp
static bool IsDropdownColumn(PawnColumnDef col) { /* Master/MedCare/Area returns true */ }
static bool IsCheckboxColumn(PawnColumnDef col) { /* the 10 cases above */ }
static bool IsReadOnlyMetadataColumn(PawnColumnDef col) { /* Sex/Age/Stage/Mood/Bond/Pregnant/Sterile-icon */ }
```

Then `DrawMatrix`:
```csharp
if (IsDropdownColumn(col)) DrawDropdownCell(cell, pawn, col);   // skip vanilla
else {
    if (IsCheckboxColumn(col)) DrawCheckboxBackdrop(cell);      // backdrop, then vanilla
    col.Worker.DoCell(cell, pawn, _table);
}
```

And `GetFocusedTooltipText`:
```csharp
if (IsReadOnlyMetadataColumn(col)) return "";                     // no tooltip at all
string captured = UniversalTooltipRegistry.Lookup(_focusedCellRect);
if (!string.IsNullOrEmpty(captured)) return captured;             // no pawn-name prefix
switch (col.workerClass.Name) { /* synthesized action-line tooltips for dropdowns */ }
return "";                                                        // unknown — no tooltip
```

*Why it's tricky:* the easy default is "every cell gets a backdrop and every cell gets a tooltip". That's wrong on both axes. A backdrop on a pure-info icon misleads (looks clickable), and a tooltip on a pure-info cell just shows the animal's name (which is already in the info panel) — visual noise. You only realize the three buckets exist after a user feedback round; bake the classification helpers in from day one of any new PawnTable Tier-3.

## Universal controller nav: patch ButtonInvisible + ButtonInvisibleDraggable + HorizontalSlider, that's all

To make controller D-pad navigation work universally across vanilla + every DLC + any third-party mod's dialogs, you only need to patch three Verse Widgets primitives — every other widget in the game routes through one of them:

- **`Widgets.ButtonInvisible(Rect, bool)`** — the click-detection chokepoint for non-draggable widgets. Catches: `ButtonText` (every overload via `ButtonTextWorker` when not draggable), `ButtonImage` (all overloads), `ButtonImageFitted`, `ButtonImageWithBG`, `ButtonTextSubtle`, `RadioButton` (both `float,float` and `Vector2` signatures), `RadioButtonLabeled`, `CheckboxLabeledSelectable`. So one Prefix here records every "click-able" rect in any UI any code draws.
- **`Widgets.ButtonInvisibleDraggable(Rect, bool)`** — the chokepoint for draggable widgets. NOT a downstream of ButtonInvisible — it's its own implementation. Catches: `ButtonTextDraggable`, `ButtonImageDraggable`, `Widgets.Checkbox` (both `Vector2` and `float,float` overloads via `ToggleInvisibleDraggable`), `Widgets.CheckboxLabeled` (also via `ToggleInvisibleDraggable`), and any paint-drag widget. Missing this means checkboxes in mod settings / DLC dialogs are unreachable to the controller.
- **`Widgets.HorizontalSlider(Rect, float, float, float, bool, string, string, string, float)`** — the slider chokepoint. `HorizontalSlider(Rect, ref float, FloatRange, …)` forwards to this overload internally.

To synthesise an A-press click via the patches:
- ButtonInvisible: Postfix sets `ref __result = true`.
- ButtonInvisibleDraggable: Prefix sets `ref __result = DraggableResult.Pressed` and returns false to skip vanilla. (Don't try to override on Postfix — vanilla has already consumed/ignored the synthetic click by then.)
- HorizontalSlider: Postfix overrides `ref __result` with the new clamped value.

*Why it's tricky:* Patching `Widgets.ButtonText` alone catches the brown buttons but misses checkboxes (which go through `ButtonInvisibleDraggable` not `ButtonInvisible`). And patching `Widgets.Checkbox` directly is a trap — it has a `ref bool checkOn` parameter, so the Harmony `[HarmonyPatch]` argument-array signature has to use `ArgumentType.Ref` and it's easy to get wrong. The `ButtonInvisibleDraggable` chokepoint sidesteps the ref-param problem entirely AND covers everything that funnels through `ToggleInvisibleDraggable`.

## Universal controller tooltips via TooltipHandler.TipRegion capture

To give controller D-pad navigation tooltips that work across vanilla + DLC + any third-party mod without hand-wiring each dialog, patch `TooltipHandler.TipRegion(Rect, TipSignal)` as a Harmony Prefix and capture `(rect, signal)` into a frame-scoped registry. Vanilla's `TipRegion` only stores tooltips when `Mouse.IsOver(rect)` is true (an optimisation for the OS mouse cursor) — your prefix runs BEFORE that gate so you record every rect/tip pair drawn this frame regardless of cursor position. Then a nav helper that knows its D-pad-focused rect can do `UniversalTooltipRegistry.Lookup(focusedRect)` to get the exact same text the source code would have shown on mouse hover.

This is a single-chokepoint patch: every `TipRegion` overload (`TipRegionByKey`, `TipRegion(Rect, string)`, `TipRegion(Rect, Func<string>, int)`) ultimately funnels through `TipRegion(Rect, TipSignal)`, so one prefix catches all tooltip registrations from vanilla, every DLC, and every other mod that uses the standard tooltip API. Store the `TipSignal` (not the resolved text) so lazy `textGetter` Funcs are only evaluated on lookup, not on every captured registration.

Double-buffer the registry: writes go into the current-frame list, reads (Lookup) consume the previous frame's snapshot. Swap on the first capture of each new frame. That avoids racing against in-progress capture mid-frame (e.g. one window's draw postfix looking up a tip a later window hasn't registered yet). Match rects with sub-pixel epsilon (≈0.6px) — vanilla rounds button rects but mods sometimes draw at slightly different offsets.

*Why it's tricky:* The obvious approach of "patch each dialog separately" doesn't scale — DLCs and mods constantly add new MainTabWindows / Dialogs / overlays you'd have to chase. `TooltipHandler.TipRegion` is the universal entry point, but vanilla's `Mouse.IsOver` gate hides the fact that ALL UI code routinely calls it for every interactive rect; once you bypass the gate in your Prefix, you have a complete frame-by-frame index of every tooltipable element in the game for free.

## Use GUIToScreenPoint(rect.center) as nav-item identity — local rect collides across nested BeginGroup calls

When you record click-target rects from a Harmony postfix on `Widgets.ButtonInvisible` / `Widgets.ButtonImage` / `Widgets.ButtonText` for D-pad navigation, do NOT use the local rect as the item identity. Vanilla widely uses `Widgets.BeginGroup(rect)` per row and then draws the trash/icon/etc at a constant LOCAL rect like `(rect.width - 30, 0, 24, 24)` — every row's icon has the IDENTICAL local rect. Faction list, drug policy rows, schedule columns, etc. all do this.

Recipe: at record time call `GUIUtility.GUIToScreenPoint(rect.center)` (safe inside OnGUI), store the screen center alongside the local rect, and use the screen center as the identity key for `IsSelected`, `ShouldSimulateClick`, and same-item filtering in spatial Move(). Keep the local rect only for drawing the highlight and feeding back into `__result` overrides.

*Why it's tricky:* If the local rect IS the key, `RectApproxEquals` returns true for every row's icon simultaneously \u2014 the yellow highlight draws on all of them at once, and an A-press synth-clicks all of them at once. Symptom: "all the trash icons are selected at the same time."

## Vanilla RimWorld 1.6 reserves F10 (TakeScreenshot) and F11 (ToggleScreenshotMode); F1-F9 and F12 are free

When picking F-key hotkeys for mod windows, the only two F-keys vanilla RimWorld 1.6 reserves are F10 (TakeScreenshot) and F11 (ToggleScreenshotMode), both defined in Core/Defs/Misc/KeyBindings/KeyBindings.xml. F1–F9 and F12 are all free for mod use by default.

Recipe: bind player-facing windows to adjacent F-keys for muscle memory (e.g. F7/F8/F9 cluster), keep dev/debug bindings on F12 (separated from player UIs by the F10/F11 vanilla screenshot keys, making a natural divide). Always set `<category>` to your own KeyBindingCategoryDef and add `<checkForConflicts>` to flag overlaps in the player's Keyboard settings panel.

*Why it's tricky:* RimWorld's vanilla KeyBindings.xml mostly uses letters (W/S/A/D/G/T/Z/B/H/Y/N/J/U/M/K/I/L/O/P/V/F/R/C/X/Q/E) — almost every letter is taken. F-keys feel "always free" but F10/F11 are silent traps because nothing in the in-game keybinding UI obviously highlights the screenshot bindings on first glance, and the collision means pressing F10 takes a screenshot AND opens your panel simultaneously without any error.

## When a Listing_Standard widget is missing inside Widgets.BeginScrollView, the viewRect height is shorter than your content

`Widgets.BeginScrollView(outRect, ref scrollPos, viewRect)` treats `viewRect.height` as the **total** scrollable content area. Anything you draw past that Y position is silently clipped — not scrollable, just gone. The label might render but the slider directly below it can vanish if the slider's Y falls past `viewRect.height`.

Pattern that works: count your sections (each `Header` ≈ 60px including the GapLine; each `CheckboxLabeled` ≈ 28; each `Label` ≈ 24; each `Slider` ≈ 22; plus your explicit `Gap()` calls) and pick a `viewRect.height` comfortably above that. For a 7-section settings panel ~1100–1300px is realistic. Set it generously — empty scroll area at the bottom is invisible, but clipped sliders are user-facing bugs.

*Why it's tricky:* the label often renders fine because it sits just before the clip line, while the slider one row below crosses the boundary. The visible symptom is "I can see the label and value, but there's no slider" — easy to mistake for a wiring bug in the slider call itself when it's actually a scroll-view sizing bug. Always update `viewRect.height` when you add a new section.

## When building a new Tier-3 main-tab menu, the FIVE bugs that block controls every time

Every Tier-3 main-tab menu I've built (Architect, Work, Schedule, Assign, Animals) has had at least one of these same five bugs at first launch — "controls don't work at all" or "controls work but stray clicks land on the map". Apply ALL of them as you scaffold the next menu, not after the user reports the bug:

1. **Gate the Tier-1/2 helper's `IsTabOpen` property** on `!YourTier3Nav.IsActive`. The old helper has its own input route in `InputCore.HandleDpad` that fires BEFORE your new Tier-3 route in the chain — when both `IsTabOpen` getters return true, the old helper's `Tick()` runs and `return`s, never reaching yours. Example: `WorkTabNavHelper.IsWorkTabOpen => !WorkTabFullScreenNav.IsActive && /* original check */;`

2. **`IsTopmostUsable` must check ONLY for FloatMenu, not "any Super/Dialog window"**. The intuitive impl enumerates `Find.WindowStack` and returns false if any `WindowLayer.Super` or `Dialog` window is on top. This is too strict — incidental `ImmediateWindow`s (tooltip overlays, drag previews, mod-added overlays) sit on those layers and break the check. Earlier route entries already claim input when sub-dialogs (`Dialog_ManageAreas`, `Dialog_AutoSlaughter`, color pickers) are on top, so you don't need to re-check them. The right impl: `IsTopmostUsable => IsTabOpen && Find.WindowStack?.FloatMenu == null;`

3. **Refresh from the live window at the top of `Tick()`** if `_pawns.Count == 0 || _table == null`. Tick fires from `GameComponentUpdate` in the Update phase, BEFORE OnGUI runs your `DrawShell` (which populates `_pawns` and `_table` via `RefreshLists`). On the FIRST frame after the user opens the tab, Tick sees empty state and returns early — the first D-pad press is dropped. Pattern: `if (_pawns.Count == 0 || _table == null) { var win = Find.WindowStack?.WindowOfType<MainTabWindow_X>(); if (win != null) RefreshLists(win); if (_pawns.Count == 0) return; }`

4. **If you use `_visibleCells` sub-cell expansion (Carry's medicine + count, drug grid's per-row sub-cells, etc.), clamp `FocusColIdx` against `_visibleCells.Count - 1`, NOT `_visibleColumns.Count - 1`**. Easy to mismatch in Tick's clamp at the top because both lists look similar in your head. Symptom: D-pad right walks fine until it hits the first sub-cell, then snaps back every Tick because the clamp drags it back into bounds.

5. **Gate EVERY relevant button handler** in `InputCore`: `HandleAButton`, `HandleBButton`, `HandleXButton`, `HandleYButton`, `HandleBackButton`, `HandleR3Button`, `HandleLBButton`, `HandleRBButton`, plus LT/RT zoom in `Patch_Camera`. Without these gates: A press synthesizes `mouse_event(LEFTDOWN)` at the cursor (closes FloatMenus you opened, clicks random map cells); B press deselects on the map behind; X press opens the nearest-thing context menu; Back toggles forbid; R3 toggles draft. The gate is one line per handler: `if (YourTier3Nav.IsTabOpen) return;` (early-return, AFTER the existing per-handler short-circuits).

*Why it's tricky:* each bug looks like an independent issue when you hit it, so the same five-fix sequence gets repeated for every new menu. Apply them all up-front and you ship a working menu on the first build instead of the third.

## When checking WindowStack.GetWindowAt from Update(), convert WorldToScreenPoint y by flipping it before dividing by UIScale

`WindowStack.GetWindowAt` and `windowRect` use GUI space: `(0,0)` top-left, y increases downward, in GUI units (`screen pixels / Prefs.UIScale`). `Camera.WorldToScreenPoint` returns y-from-bottom in screen pixels. The correct conversion to GUI space is:

```csharp
float uiScale = Prefs.UIScale;
Vector2 pawnUI = new Vector2(s3.x / uiScale, (Screen.height - s3.y) / uiScale);
if (Find.WindowStack.GetWindowAt(pawnUI) != null) skip;
```

`UI.MousePositionOnUIInverted` (used by CameraDriver) is the same space — it converts `Event.current.mousePosition` (y-from-bottom in Unity screen) to y-from-top in GUI units. Despite the name "Inverted", it produces the **standard** GUI y-from-top coordinate that windowRect uses. `Event.current.mousePosition` is y-from-bottom matching `Input.mousePosition`, NOT y-from-top as Unity IMGUI docs sometimes imply.

*Why it's tricky:* the name "Inverted" implies it's the unusual direction, but it's actually the direction windowRects are stored in. Using `s3.y / uiScale` (y-from-bottom) instead of `(Screen.height - s3.y) / uiScale` (y-from-top) silently fails — `GetWindowAt` returns null for all positions even when a window clearly covers the point.

## When gating B in HandleBButton for a Tier-3 menu, you MUST also handle B in your Tick or close stops working

The "B closes the tab" affordance in Tier-3 menus usually works **by accident** — `InputCore.HandleBButton`'s default fallback synthesizes `VK_ESCAPE`, which RimWorld's vanilla Esc handler closes the topmost window. So a menu that doesn't gate B AND doesn't implement B in its Tick still closes on B press.

The moment you add `if (YourTier3Nav.IsTabOpen) return;` to `HandleBButton` (to stop B from leaking to map-side effects — selection deselect, inspector tab collapse, etc.), the Escape synth stops firing and **B no longer closes the menu**. Symptom the user reports: "B button doesn't close the menu."

Fix: every Tier-3 menu MUST have **both** the gate AND a Tick-level B handler. Pattern:

```csharp
// In InputCore.HandleBButton — gate (prevents map-side leakage):
if (YourTier3Nav.IsTabOpen) return;

// In YourTier3Nav.Tick():
if (XInputHelper.JustPressed(XInputHelper.BTN_B))
{
    XInputHelper._bConsumedThisFrame = true;
    var w = Find.WindowStack?.WindowOfType<MainTabWindow_X>();
    if (w != null) Find.WindowStack.TryRemove(w);
}
```

This is the **same pattern as A press** (gate in `HandleAButton` to prevent `mouse_event` synth + handle in Tick), the **same pattern as Y press** (gate in `HandleYButton` to prevent time-speed change + handle in Tick), etc. The principle: **if you gate a button, you take ownership — you MUST handle it explicitly.**

Add this as bug #6 to the "Tier-3 main-tab menu" checklist. Lore reference: `read_lore ui` → "When building a new Tier-3 main-tab menu, the FIVE bugs that block controls every time" (now SIX).

*Why it's tricky:* the menu silently appears to work without a B handler (Escape synth closes it). The bug only appears AFTER you add the gate, which feels like a regression — but the gate is correct, the missing handler is the bug.

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

## When Tick() cleanup never runs during a scene transition, static nav state goes stale

When a nav helper tracks "am I in pause-menu mode" via static fields, those fields survive the game→main-menu scene transition. `Root.Update()` suppresses `UIRootUpdate()` while a long event is running (`LongEventHandler.ShouldWaitForEvent == true`), so any cleanup logic that lives inside a `Tick()` that is only called from `UIRootUpdate` is **never executed** during the transition. On the first frame at the main menu, the helper sees `_initialized = true` and stale pause-menu rects, and draws highlights at the wrong position.

*Fix*: add a stale-state guard at the top of `Tick()` — if `ProgramState == Entry` but `_isPauseMenu` is still set, call `ClearPauseMenuRect()` and set `_initialized = false` so `RebuildItems()` runs with the correct main-menu layout on that first tick.

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

## When a Tier-3 menu opens via PollSelection, prime its visible-row list inside OpenWindow — Tick reads Update phase, DrawShell runs OnGUI

Selection-triggered Tier-3 windows (StockpileFullScreenNav, similar future ones) have a one-frame hole: `Tick()` is dispatched from `GameComponentUpdate` during Unity's **Update phase**, but the per-frame `BuildRows()` (or equivalent visible-cell layout pass) usually lives inside `DrawShell()` which only runs during **OnGUI**. Order per frame is Update → OnGUI, so on the FIRST frame the window exists, Tick sees `_rows.Count == 0`. Every `_focusIdx >= 0 && _focusIdx < _rows.Count` guard fails, A/X effectively no-op, and any `if (_focusIdx < _rows.Count - 1) _focusIdx++; else { _zone = N }` branch hits the `else` immediately — so a single D-pad press silently swaps zones before the user has seen anything. Reads to the player as "the menu opened but isn't focused for D-pad navigation."

Recipe: call `BuildRows()` (and any count cache / index clamp) at the bottom of `OpenWindow()`, wrapped in try/catch so a transient null in `Target?.GetStoreSettings()?.filter` can't block the window from opening. Defense-in-depth: at the top of each per-zone Tick handler, early-out on empty rows with a quiet `Tick_Tiny` sound rather than allowing the auto-zone-swap branch to fire.

*Why it's tricky:* the bug doesn't reproduce on the SECOND frame onward — OnGUI has run by then — so single-frame logging traces look fine. The user only sees it because the very first press happens before BuildRows ever ran. Symptom is "controls feel dead" but only on open; press anything else first (e.g. opening any other window between selection and stockpile) and it works, masking the bug.

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

## When taking over a vanilla MainTabWindow with a Tier-3 shell, also resize the vanilla window AND TryRemove it on close

Patching `MainTabWindow_*.DoWindowContents` Prefix to return false skips vanilla's draw, but the vanilla window's brown frame still renders at its default size (e.g. 1010×640 for Quests) and peeks around the edges of your 95%×95% Tier-3 shell. Add a Postfix on `Window.SetInitialSizeAndPosition` gated by `__instance is MainTabWindow_*` that resizes the vanilla window to match your Tier-3 dimensions — the frame is then completely hidden behind your shell.

On close (B button), call `Find.WindowStack.TryRemove` on BOTH your Tier-3 Window AND the underlying vanilla MainTabWindow. Removing only your shell leaves the (now invisible because your patch returns false) vanilla MainTab open underneath — the player presses B expecting "menu closed" and gets an empty screen instead, with no further input target.

Recipe summary:
1. `[HarmonyPatch(MainTabWindow_Quests, DoWindowContents)]` Prefix → return `!IsTier3Active`.
2. `[HarmonyPatch(Window, SetInitialSizeAndPosition)]` Postfix gated on `__instance is MainTabWindow_Quests` → set `windowRect` to your 95% screen size.
3. On B: walk `Find.WindowStack` for `WindowOfType<MainTabWindow_Quests>()` and `TryRemove(w)` BEFORE closing your own window.

*Why it's tricky:* vanilla MainTabs are GameUI-layer, not Dialog-layer, so they sit below your Dialog-layer Tier-3 — but their frame, close-X, and content-rect background still render. Without resizing them, the screen edges show a half-eaten vanilla panel poking out from behind your shell.

## Controller-triggered FloatMenus need explicit FloatMenuAnchor.Set; auto-anchor only fires for ButtonInvisible click paths

The universal `FloatMenuAnchor` auto-tracker (Postfix on every `Widgets.Button*`) only fires for mouse clicks that route through one of those button helpers. **Controller A-press paths that call the same action handler directly bypass `ButtonInvisible` and therefore never set an anchor** — the FloatMenu falls back to vanilla cursor positioning, which on controller is wherever the user last left the mouse (usually wrong).

Recipe: cache each focused row/cell's `Rect` during the draw pass into a static array, and at the top of the controller A-press handler call `FloatMenuAnchor.Set(_rowRects[focusedIdx])` BEFORE invoking the action. Same pattern that the mouse path gets for free, just made explicit for controller.

```csharp
// Draw pass — cache rect every frame:
var modeRect = new Rect(inner.x, y, inner.width, DetailRowH);
_detailRowRects[DR_MODE] = modeRect;
if (DrawDetailButton(modeRect, "Do X times ▾", focused)) MakeConfigFloatMenu(bp);

// Controller A handler — set anchor explicitly:
if (XInputHelper.JustPressed(XInputHelper.BTN_A))
{
    if (_detailRowRects[_detailRow].width > 0f)
        FloatMenuAnchor.Set(_detailRowRects[_detailRow]);
    BillRepeatModeUtility.MakeConfigFloatMenu(bp);   // would otherwise open at cursor
}
```

*Why it's tricky:*
- The mouse and controller code paths LOOK like they call the same function (`MakeConfigFloatMenu`), so it's natural to assume both get anchored. They don't — only the mouse path passes through `Widgets.ButtonInvisible` which the Postfix patch listens to.
- Forgetting this manifests as "the menu opens at my mouse cursor when I press A", which to the user looks like a regression of the universal-anchor system. The system is working — the controller path is what's missing.
- A useful audit pattern: grep for `MakeConfigFloatMenu`, `Find.WindowStack.Add(new FloatMenu(`, etc. in any controller `Tick` / handler method, and ensure each call is preceded by `FloatMenuAnchor.Set(...)`.

## FillTab-heartbeat windows: B-close needs a _userClosed gate keyed by target, else FillTab re-opens next frame

Tier-3 windows driven by an `ITab.FillTab` Prefix heartbeat (e.g. Bills Tier-3 opened by `ITab_Bills.FillTab`) have a sneaky close-button bug: pressing B closes the window, but **the vanilla inspector's open ITab is still ITab_Bills, so the very next frame `FillTab` fires again, runs your Prefix, calls `NotifyFillTabActive` → `EnsureWindowOpen` → window reopens**. The user perceives "B doesn't close the menu".

Recipe: add a `_userClosedTarget` field keyed to the SelectableThing (e.g. workbench). When the user B-closes, store the current target. In `NotifyFillTabActive`, refuse to reopen when the current target equals `_userClosedTarget`. Clear the flag when the target changes (different building selected) so re-selecting is enough to bring it back. An explicit X-press opener (like `OpenForWorkbench`) should also clear the flag to override a prior close.

```csharp
static Building_WorkTable? _userClosedTarget = null;

// B-close path:
if (B pressed && _zone == Zone.List) {
    _userClosedTarget = GetTargetTable();
    CloseWindow();
}

// FillTab heartbeat:
public static void NotifyFillTabActive() {
    _lastNotifiedFrame = Time.frameCount;   // keep IsActive/IsTopmostUsable accurate
    var target = GetTargetTable();
    if (_userClosedTarget != null && _userClosedTarget == target) return;  // user-closed gate
    _userClosedTarget = null;
    EnsureWindowOpen();
}
```

*Why it's tricky:*
- FillTab fires every frame on the active ITab — closing your window doesn't change which ITab is "open" on the vanilla inspector, so the heartbeat never stops.
- Without the gate, B-close oscillates: closes one frame, reopens next, closes again on the next B-press, reopens again. To the user this looks like B is broken.
- The gate must be keyed to the target object (not just a boolean) so selecting a DIFFERENT workbench naturally clears it — otherwise the user would have to deselect-and-reselect after every close.

## Tier-3 window triggered by ITab heartbeat must use WindowLayer.GameUI not Dialog

When a Tier-3 full-screen nav opens a Window that relies on a per-frame heartbeat from an ITab (`FillTab` Prefix calling `NotifyActive()` / setting `_lastNotifiedFrame`), use **`WindowLayer.GameUI`**, never `WindowLayer.Dialog`.

**Recipe:** Set `layer = WindowLayer.GameUI` in the Window subclass constructor. Keep `preventCameraMotion = false`. The `IsTopmostUsable` loop (`w.layer == WindowLayer.Dialog || w.layer == WindowLayer.Super → return false`) still correctly yields to real modal dialogs that open on top.

**Why it's tricky:** `WindowLayer.Dialog` suppresses all lower-layer draw calls — including `InspectPaneUtility.InspectPaneOnGUI()`, which is where `ITab.FillTab()` is invoked. With the inspector suppressed, the heartbeat (`_lastNotifiedFrame`) goes stale in ~4 frames. `Tick()` detects the stale heartbeat at the very first check, closes the window, and returns before any input-handling code runs. The window oscillates: opens → Dialog suppresses inspector → heartbeat dies → window closes → inspector draws → heartbeat fires → window reopens → repeat. From the user's perspective: controls are completely dead.

This affects **any** Tier-3 menu whose liveness is derived from an ITab draw callback. Menus triggered by main-tab window `DoWindowContents` intercepts are unaffected (main-tab Window stays on the stack regardless of layer).

**Error signature:** "no controller controls working in the new [menu]" — window appears to open but all D-pad/button input is silently dropped.

## Universal FloatMenu button-anchoring: Postfix every Widgets.Button* + repos in FloatMenu.SetInitialSizeAndPosition

To anchor every "click a button → open a FloatMenu" path to the **button rect** instead of the mouse cursor (controller-friendly UX), don't try to enumerate every call site. Two pieces:

1. A static one-shot tracker: `RecordButtonClick(rect)` stashes `(rect, frameCount)`. `TryConsume(out rect)` accepts this-frame or last-frame and clears state.
2. **Postfix every `Widgets.Button*` overload** with `[HarmonyPatch] static IEnumerable<MethodBase> TargetMethods()` enumerating each `AccessTools.Method(typeof(Widgets), "ButtonText"|"ButtonImage"|...)`. In the Postfix, `if (__result) FloatMenuAnchor.RecordButtonClick(rect)`. Then Postfix `FloatMenu.SetInitialSizeAndPosition` to reposition `__instance.windowRect` next to the consumed rect (with screen-edge flips) and set `__instance.vanishIfMouseDistant = false` — anchored menus open far from the cursor and would otherwise self-close in ~half a second.

*Why it's tricky:*
- Param name differs across overloads — `ButtonText`/`ButtonTextSubtle` use `rect`, `ButtonImage`/`ButtonInvisible` use `butRect`. Harmony binds by name, so split into two helper classes with two `TargetMethods()` enumerations.
- A single `[HarmonyPatch(typeof(Widgets), nameof(ButtonText))]` without arg-type filter triggers Harmony's ambiguous-method error when there are multiple overloads. Use `TargetMethods()` with explicit `AccessTools.Method(t, name, new[]{...})`.
- `FloatMenu.vanishIfMouseDistant` defaults to true; without flipping it off, controller/anchored menus fade based on cursor distance and self-close. Only flip it for **anchored** opens — mouse-opened menus should keep vanilla behavior.
- Don't try to track only "buttons that open FloatMenus" — there's no signal. Track every clicked button rect; the 1-frame consume window in `TryConsume` discards stale rects naturally when no FloatMenu opens.
- World right-click context menus (`FloatMenuMap`) inherit from `FloatMenu` so the Postfix fires, but no button click is recorded → tracker empty → falls through to vanilla cursor positioning. Correct behavior.

## When implementing custom D-pad nav alongside UniversalButtonNavHelper, always suppress the helper to prevent double-input

If both a custom Tick-style nav helper AND `UniversalButtonNavHelper.Tick()` run on the same window in the same frame, D-pad events are processed twice and A-button clicks fire on whichever widget the *universal* helper's spatial finder landed on — which may differ from your custom `_focusIdx`. This causes phantom card activations ("snapping to boxes I haven't selected").

Fix: In `HandleDpad()`, gate the universal helper call with `!MyNav.IsTopmostUsable`:
```csharp
if (!ScenarioPickerNav.IsTopmostUsable && !MainMenuFullScreenNav.IsTopmostUsable
    && UniversalButtonNavHelper.IsActive)
    UniversalButtonNavHelper.Tick();
```

Pattern applies to every Quests-style take-over nav: the moment you have an `IsTopmostUsable` / `Tick()` pair, you must add that nav to the suppression chain in `HandleDpad()`.

## Consumed-flag gates must be per-button inline, never a blanket return at top of Tick

When a nav helper's `Tick()` runs inside `PollIfNeeded` BEFORE input poll + consumed-flag reset, it reads LAST frame's `_aConsumedThisFrame` / `_bConsumedThisFrame`. The temptation is to gate the whole method:

```csharp
// WRONG — freezes all controls for a frame after any other helper consumes A or B
void Tick() {
    if (XInputHelper._aConsumedThisFrame || XInputHelper._bConsumedThisFrame) return;
    // ...D-pad, X, LB/RB, triggers all blocked too
}
```

That blocks D-pad, X, shoulders, triggers — every input, not just the consumed button. Since universal helpers (FloatMenuNav, UniversalButtonNav synthesizing Return, etc.) frequently set `_aConsumedThisFrame=true`, the Tier-3 nav appears to lock up after any A press anywhere.

Correct pattern: inline check on each specific A/B handler:

```csharp
if (JustPressed(B) && !_bConsumedThisFrame) { /* close */ }
bool aJustPressed = JustPressed(A) && !_aConsumedThisFrame;
if (aJustPressed || JustPressed(DpadRight)) { /* enter details */ }
```

*Why it's tricky:* The blanket gate "works" in isolation — your unit-test scenario only fires A then expects no re-fire — but in-game, A and B get consumed every frame by something somewhere (FloatMenu just closed, UniversalNav synthesized Return on a button, etc.), so the gate becomes a near-permanent input freeze. Always scope consumed-flag gates to the exact button they protect, never the whole Tick.

## FloatMenuMap guard prevents world right-click menus from consuming button-anchors via race condition

When using a universal button-anchor system (`FloatMenuAnchor`), always add an explicit `if (__instance is FloatMenuMap) return;` guard at the top of the `FloatMenu.SetInitialSizeAndPosition` Postfix, **before** calling `TryConsume`.

Without it there is a 1-frame race: a UI button click sets an anchor (`_lastButton` / `_lastButtonFrame`), and if a `FloatMenuMap` world context menu opens within the same 1-2 frame consume window, it wrongly gets repositioned to the UI button's rect instead of the world click position.

`FloatMenuMap` is the `FloatMenu` subclass that genuinely wants cursor positioning (`is FloatMenuMap` also catches any subclasses; `FloatMenuWorld` is the world-map context-menu equivalent — add a parallel guard there if your anchor system fires on the world map) — they represent "you clicked here on the map". Every other `FloatMenu` subclass opened from a UI button benefits from anchoring. The guard makes this explicit and eliminates the race permanently rather than relying on "the tracker happens to be empty" for correctness.

## Tier-3 input gates must check IsWindowOpen, not IsActive — IsActive stays true after window closes

A Tier-3 nav helper typically exposes both `IsActive` (feature-on + correct selection / topmost main-tab) and the implicit "is my window currently in the stack" state. Every `HandleA/B/X/Y/RB/LB/Start/Dpad/Camera` handler in `InputCore` will be gated like `if (FooNav.IsActive) return;` — but `IsActive` does NOT track whether the user pressed B to close the window. After B-close:
- `_window` is removed from the stack
- The selection / main-tab condition is still true (workbench still selected, tab still open, etc.)
- `IsActive` returns true → every handler bails → **all controller input dies**

Fix: expose a strict `IsWindowOpen` accessor that ONLY returns true when the window is in `Find.WindowStack`, and gate every input handler on THAT, not on `IsActive`:

```csharp
public static bool IsWindowOpen =>
    _window != null && Find.WindowStack?.Windows?.Contains(_window) == true;
```

Then `sed -i 's/FooNav\.IsActive/FooNav.IsWindowOpen/g' input/InputCore.cs` over every handler-gate site. Keep `IsActive` for the *Tick lifecycle* (it decides whether to reopen the window) — those two concerns are different.

*Why it's tricky:* The bug only manifests if your B handler doesn't also flip the underlying selection/tab state. As long as `IsActive` includes "feature enabled + workbench selected", a B-close leaves controls dead until the user reselects. The fix is two accessors with one-line difference — easy to write, easy to miss.

## Tier-3 windows opened at the main menu MUST consume Esc in OnCancelKeyPressed

If your custom `Window` overrides `closeOnCancel = false` (because you want to handle B/Esc yourself via a nav helper), you ALSO have to override `OnCancelKeyPressed` to do **both** `Close()` and `Event.current.Use()`. Vanilla's `Window.OnCancelKeyPressed` only calls `Event.current.Use()` when `closeOnCancel` is true — so with closeOnCancel=false and an empty override, the Esc keypress is never consumed and propagates to the next window in the stack.

```csharp
public override void OnCancelKeyPressed()
{
    try { if (Find.WindowStack != null && Find.WindowStack.IsOpen(this)) Close(); } catch { }
    try { if (Event.current != null) Event.current.Use(); } catch { }
}
```

*Why it's tricky:* Steam Input commonly maps controller B → physical Esc. At the title screen this means a B press opens the Quit-confirm dialog the moment your Options/whatever window closes — looks like a "double press" to the user. The fix is to consume the keyboard Event in OnCancelKeyPressed even though `closeOnCancel` is false. The XInput-driven B handler in your own Tick still works as a fallback for controllers without Steam Input remapping.

## When recording widget rects inside a vanilla scroll view for D-pad nav, use draw-order index not screen-space position

When recording widget rects inside a vanilla `BeginScrollView` for D-pad nav (e.g. `Dialog_Options.DoOptions`), **do not store screen-space rects and compare them across frames**. If scroll changes between frames (e.g. `ScrollToContent()` updates `optionsScrollPosition`), the stored positions are stale and the highlight/click-sim will never match — the symptom is a focus highlight that never appears, or A-press that never activates the cell.

The correct approach is **draw-order index**: since `Listing_Standard` draws top→bottom every frame in the same order, draw order == visual order == sorted order. Pass the scratch index from Harmony Prefix to Postfix via `out int __state`:
```csharp
// Prefix:
static void Prefix(Rect rect, string label, ref bool drawBackground, out int __state) {
    __state = -1;
    if (OptionsNavHelper.IsActive && OptionsFullScreenNav._inContentArea) {
        OptionsNavHelper.RecordOption(rect, label, null);
        __state = OptionsNavHelper.RecordedScratchCount - 1; // draw-order index
        drawBackground = false; // suppress vanilla gold/brown
    }
}
// Postfix:
static void Postfix(Rect rect, ref bool __result, int __state, ...) {
    if (__state >= 0 && __state == OptionsFullScreenNav._contentIdx) {
        OptionsFullScreenNav.DrawContentFocusHighlight(rect); // highlight
        if (OptionsNavHelper._pendingCellClick && active) {
            __result = true; // A-press sim
            OptionsNavHelper._pendingCellClick = false;
        }
    }
}
```
For `ButtonInvisibleDraggable` (checkbox toggle path): same pattern in Prefix, set `__result = Widgets.DraggableResult.Pressed` when draw index matches. For sliders: record then immediately check `RecordedScratchCount - 1 == _contentIdx` in the same Postfix. Note: dedup does NOT decrement the count — after a dedup skip, `Count - 1` still points at the last successfully added entry (the same cell, same index). ✓

## When replacing a legacy nav helper, grep HandleDpad for EVERY call site of the old helper

When you Tier-3-replace an existing nav helper (e.g. `PolicyNavHelper.Tick` → `PolicyFullScreenNav.Tick`), grep `InputCore.HandleDpad` for **every** `OldHelper.Tick()` call site, not just the obvious one. The same helper is often called from multiple places in the routing chain — typically one earlier site (above the LB-modifier early-return) for shoulder-button consumption, and one later site (after LB-modifier) for the general dispatch. If you add your new helper's route below only the later site, the earlier site's `OldHelper.Tick()` runs FIRST and `return`s — your new route is unreachable, and the symptom is **"no controls work in any of the new sub-menus"**.

**Recipe:**
1. `grep "OldHelper\.Tick\|OldHelper\.IsTopmost" InputCore.cs` to find every dispatch.
2. Replace EACH with `if (NewHelper.IsTopmostUsable) { NewHelper.Tick(); return; } if (OldHelper.IsTopmost) { OldHelper.Tick(); return; }` (new first, legacy fallback for when the setting is off).
3. Remove the now-redundant later dispatch if it's only there for the same helper.

*Why it's tricky:* the new route looks correct in isolation — but the routing chain is order-dependent and one of the legacy sites was intentionally placed BEFORE the LB-modifier block to win over LB-held early-out. Your new route added below that block is dead code. The build passes, the Harmony patches load, the shell draws fine, focus highlight even appears on row 0 — but D-pad does nothing because legacy `Tick` consumed the input on a prior code path. Compounding the diagnosis: legacy `OldHelper.Tick` likely doesn't render anything visible inside the new shell so it just silently eats input.

## When a controller-B opens a MainTabWindow that instantly flashes closed, suspect your OWN Tick's toggle branch, not vanilla cancel-key

Symptom: pressing controller-B on the map opens the pause/Menu tab then it instantly closes (a flash), often dragging visible bottom-bar/cell-info redraws with it. The intuitive culprit is vanilla's Escape handling (Steam double-binds controller-B to gamepad-B AND keyboard-Escape), so you reach for Harmony patches on `Window.OnCancelKeyPressed` / `Window.Close`.

Recipe: Before patching vanilla, check whether YOUR input Tick has a B→toggle/resume branch that runs on the same B press that opened the window. A single B press both opens (your open branch) and then closes (your resume branch) in the same frame. Guard the close branch with an "opened-this-frame" flag: stamp `_menuTabOpenedFrame` when you detect the tab transitioned to open, expose `MenuTabJustOpened` (frame-count window ~12 frames), and have the resume/close branch early-return when it's true. Critically, the open-transition detector must run BEFORE the Tick that reads the flag.

*Why it's tricky:* Harmony diagnostic Prefixes on `Window.Close` and `Window.OnCancelKeyPressed` NEVER FIRED — proving the close didn't go through either. `WindowStack.TryRemove` calls `PreClose`/`PostClose` directly and bypasses `Window.Close()` entirely. So the close path was invisible to the obvious patch points; the real closer was the mod's own `TryRemove(menu)` in its nav Tick.

## When recording a Widgets.HorizontalSlider rect for nav/highlight, capture it in a Prefix — the body mutates rect.y

`Verse.Widgets.HorizontalSlider` mutates its own `rect` parameter at the **top** of the method before drawing:
```csharp
if (middleAlignment || !label.NullOrEmpty())
    rect.y += Mathf.Round((rect.height - 10f) / 2f);   // ~+10px on a 30px row
```
`Listing_Standard.SliderLabeled` always passes `middleAlignment: true`. So a Harmony **Postfix** that records `rect` (for D-pad focus-box positioning, click-sim, etc.) captures the already-shifted Y and your highlight lands ~10px low — over the gap or the next row. In a record-driven options/settings nav this looks like "the focus box is on the wrong item," and it only affects the one category that mixes a slider in with checkboxes/buttons (e.g. RimWorld's Graphics tab: Resolution dropdown + Fullscreen/TextureCompression checkboxes + ScreenShakeIntensity slider).

*Why it's tricky:* every other widget (CheckboxLabeled, ButtonText) records its rect untouched, so the bug is invisible until a slider shares the list — and the nav's own up/down index stays self-consistent, so you chase coordinate-transform red herrings instead of the parameter mutation. Fix: add a `Prefix(Rect rect, out Rect __state){ __state = rect; }` and use `__state` in the Postfix for anything that positions off the row.

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

## Tier-3 menu opens a Dialog_Rename/Dialog_Confirm via X — set _xConsumedThisFrame before adding the window

When a Tier-3 menu's Tick (driven from HandleDpad) handles an X-press by adding a sub-dialog like `Dialog_Rename<T>` to the WindowStack, **always set `XInputHelper._xConsumedThisFrame = true` (and `return`) before/after the `Find.WindowStack.Add(...)` call**. Otherwise the sub-dialog opens and instantly closes again on the same frame.

Why it's tricky: per-button handlers (HandleAButton/BButton/XButton/...) run AFTER HandleDpad in `Mod.cs`'s Update order. The X-press handler's early-return guard `if (MyTier3Nav.IsTopmost) return;` no longer fires the moment the sub-dialog is on top, because `IsTopmost` checks the topmost Dialog-layer window. HandleXButton then reaches its `if (UniversalButtonNavHelper.IsActive) keybd_event(VK_RETURN, ...);` branch — which the just-opened sub-dialog catches as Enter and treats as Accept, calling `Find.WindowStack.TryRemove(this)`.

The `_xConsumedThisFrame` flag is the only one HandleXButton honours at the top of the function, so it's the right way to short-circuit the synth. Same fix pattern applies if a Tier-3 Y handler opens a sub-dialog that listens for Enter — set `_yConsumedThisFrame` defensively.

This bit ManageAreasDialogNav's X=Rename and the symptom was exactly "rename text box opens then closes immediately". The reference good-pattern is `PolicyFullScreenNav.Tick`'s `if (y) { DoRenamePolicy(dlg); XInputHelper._yConsumedThisFrame = true; return; }`.

## When scoping nav candidates to a Window.windowRect, scale it by Prefs.UIScale first

`Window.windowRect` is in LOGICAL UI units (the `UI.screenWidth` space, = physical px / `Prefs.UIScale`). But anything you derive from `GUIUtility.GUIToScreenPoint(...)` is in PHYSICAL pixels, because `UI.ApplyUIScale()` sets `GUI.matrix = Matrix4x4.TRS(0, identity, scale(Prefs.UIScale))`. At `Prefs.UIScale == 1` the two spaces coincide and everything works; at any other scale a test like `windowRect.Contains(screenCenterFromGUIToScreenPoint)` silently fails.

Recipe: when filtering/scoping recorded widget centers (GUIToScreenPoint output) against a window rect, convert the rect into physical px first: `if (s != 1f) wr = new Rect(wr.x*s, wr.y*s, wr.width*s, wr.height*s);` where `s = Prefs.UIScale`.

*Why it's tricky:* it only manifests at non-1× UI scale AND only when a dialog opens over another window that also feeds the same nav snapshot. Symptom in our case: the in-game "Really quit?" `Dialog_MessageBox` over the ESC menu showed no focus box and ignored the controller — focus had been seeded onto the menu buttons drawing *behind* the box because the mis-scaled scope rejected the dialog's own buttons and the unfiltered fallback picked the topmost-leftmost item overall. Confirms over the bare map looked fine (no competing recorded widgets), which masks the bug during testing at scale 1.

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
