## Harmony is a MOD dependency, not a NuGet runtime dependency

The canonical RimWorld pattern (since ~2020): your mod depends on Brrainz's "Harmony" mod (packageId `brrainz.harmony`, Steam Workshop id 2009463077). That mod loads `0Harmony.dll` once into the AppDomain before any user mod runs. Your mod compiles against `Lib.Harmony` NuGet purely for type signatures and DOES NOT ship its own `0Harmony.dll`.

**About.xml:**
```xml
<modDependencies>
  <li>
    <packageId>brrainz.harmony</packageId>
    <displayName>Harmony</displayName>
    <steamWorkshopUrl>steam://url/CommunityFilePage/2009463077</steamWorkshopUrl>
    <downloadUrl>https://github.com/pardeike/HarmonyRimWorld/releases/latest</downloadUrl>
  </li>
</modDependencies>
<loadAfter>
  <li>brrainz.harmony</li>
</loadAfter>
```

**.csproj:**
```xml
<PackageReference Include="Lib.Harmony" Version="2.4.1" PrivateAssets="all">
  <ExcludeAssets>runtime</ExcludeAssets>
</PackageReference>
```

`ExcludeAssets="runtime"` is the magic — it lets the build see HarmonyLib types (so you can write `[HarmonyPatch(...)]` etc.) but stops MSBuild from copying `0Harmony.dll` into your `Assemblies/` folder. The Brrainz mod provides the actual runtime DLL.

*Pin exactly — don't guess:* the `2.4.1` above is not arbitrary. It MUST equal the exact `0Harmony.dll` version `brrainz.harmony` currently ships. As of RimWorld 1.6 (x64 and arm64) that is **2.4.1**, which is also the version ModMixer's own live/test harness bundles — so a mod pinned to 2.4.1 binds cleanly in the test loop *and* in players' games. Use this value directly; you do not need to inspect the DLL. Never use a floating `2.*` or a stale pin — see *"Never use a floating Lib.Harmony Version"* below for why a version mismatch silently kills every def in the mod.

*Why it's tricky:* `PrivateAssets="all"` alone does NOT prevent the .dll being copied to output — it only prevents transitive dependency exposure. You need `ExcludeAssets="runtime"` to actually skip the runtime copy. Without it, your mod ships `0Harmony.dll` and conflicts with every other Harmony-using mod that does the same — players see `TypeLoadException` for `HarmonyLib.HarmonyPatch` at boot.

*Why NOT ship `0Harmony.dll` yourself:* if two mods both ship Harmony at slightly different versions (very common — every release of `Lib.Harmony` is a new version token), Mono's assembly resolver picks one and the other mod's patches die at boot with `TypeLoadException`. Brrainz's mod centralizes this so there's exactly one Harmony in the AppDomain.

*Why NOT reference RimWorld's bundled Harmony:* RimWorld 1.5+ ILMerges Harmony into `Assembly-CSharp.dll` for its own internal use, but those types aren't exposed for compilation — you can't build against them.

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

## When computing GUI-space distance in a Harmony prefix, use Event.current.mousePosition — never convert Input.mousePosition manually

Inside a Harmony prefix on any method called during `OnGUI()`, `Event.current.mousePosition` gives the mouse position in the correct GUI coordinate space — already accounting for `GUI.matrix`, UI scale, and scroll-view offsets. Computing distance between a `Rect` parameter and `Event.current.mousePosition` in the same prefix is always coordinate-correct.

Do NOT try to reproduce GUI space from `Update()` by flipping `Input.mousePosition` with `Screen.height - y`. That formula breaks whenever RimWorld's UI scale (`Prefs.UIScale`) is not 1.0 — the scaled GUI units don't match raw screen pixels, so button rects and the mouse end up in different spaces and the distance is wrong.

Pattern for caching GUI-space proximity across the Update/OnGUI boundary:
1. In the Harmony prefix (during OnGUI), compute the distance and store it in a static field (`float MinDist`).
2. Reset that field once per Unity frame using a `Time.frameCount` guard in a separate `UIRoot.UIRootOnGUI` prefix.
3. Read `MinDist` from `GameComponentUpdate()` — it's one frame behind, which is imperceptible.

Also requires `UnityEngine.IMGUIModule.dll` referenced in the csproj for `UnityEngine.Event` to compile.

## When patching overloaded methods, specify the parameter types in HarmonyPatch

`Widgets.ButtonText` and many other vanilla helpers have multiple overloads. Using `[HarmonyPatch(typeof(Widgets), nameof(Widgets.ButtonText))]` without a `Type[]` argument throws at static-ctor time:

```
HarmonyException: Ambiguous match for HarmonyMethod[(class=Verse.Widgets, methodname=ButtonText, type=Normal, args=undefined)]
```

Always include the parameter type array for any method that's overloaded:

```csharp
[HarmonyPatch(typeof(Widgets), nameof(Widgets.ButtonText),
    new[] { typeof(Rect), typeof(string), typeof(bool), typeof(bool), typeof(Color), typeof(bool), typeof(TextAnchor?) })]
```

*Why it's tricky:* the error is thrown by Harmony before any of your patches run, so it kills your entire mod's patch class at load — the user sees a TypeInitializationException on ColonistAimAssist.HarmonyPatches static constructor with no clear pointer to which patch is at fault. Look near the bottom of the stack for the original method name (`methodname=ButtonText`).

## When recording layout rects of a recursive method, use Prefix not Postfix or order is reversed

If you're patching a method that recurses into itself (or into helpers that re-enter it) — for example `Listing_TreeThingFilter.DoCategory` which calls `DoCategoryChildren` which calls `DoCategory` again for sub-categories — and you record layout/cell rects in a Postfix, the recorded order is REVERSED relative to draw order. The Postfix on the outer call runs AFTER the inner-call Postfixes have already run, so children appear at LOWER indices than their parent in your captured list. Any "walk back to find the enclosing parent" logic then silently finds the wrong sibling instead of the actual parent.

Recipe: record the rect in a Prefix (capture `curY` / whatever positional state you need before the original method draws and recurses). Use a Postfix only for state that must be observed AFTER children — e.g. the final advanced `curY`. Captured rect Y is identical either way (Prefix `curY` IS the row's top-left).

*Why it's tricky:* the rect's Y coordinate looks correct in both Prefix and Postfix (same `curY` snapshot), so visual highlighting works fine. The bug only surfaces when other code does index-based traversal of the captured list — and the symptom (highlight jumps to a sibling, parent isn't collapsed) doesn't obviously point at "your patch fires in the wrong order".

## GameComponent.GameComponentUpdate does NOT fire in Entry state — patch UIRoot_Entry.UIRootUpdate for new-game / main-menu input

`GameComponent.GameComponentUpdate` only fires when `Current.Game != null` — i.e. once you're inside a loaded game (ProgramState.Playing). The entire `ProgramState.Entry` phase (main menu, scenario picker, storyteller picker, Page_CreateWorldParams, Page_ConfigureStartingPawns, etc.) runs WITHOUT GameComponent ticks. Code there must hook `UIRoot_Entry.UIRootUpdate` instead.

Recipe: Postfix-patch `UIRoot_Entry.UIRootUpdate` and drive your input handlers from there. Internally `UIRoot_Entry.UIRootUpdate` calls `WindowStack.WindowStackOnGUI`, so it's a once-per-frame Update-phase callback in Entry state (parallel to `UIRoot_Play.UIRootUpdate` which handles Playing state).

*Why it's tricky:* Removing the `if (Current.ProgramState != ProgramState.Playing) return;` from `GameComponentUpdate` looks like it should let it run in Entry — it doesn't, because the engine simply never calls it when there's no `Current.Game`. The fix is at the patch site, not the gate.

## Never use a floating Lib.Harmony Version="2.*" — pin exactly to brrainz.harmony's shipped 0Harmony.dll version

RimWorld's Mono refuses to bind a typeref like `HarmonyLib.CodeInstruction` from `0Harmony, Version=2.4.2.0, PublicKeyToken=null` to a loaded `0Harmony, Version=2.4.1.0` — even though both are weakly-named. The result is a `ReflectionTypeLoadException` on `Assembly.GetTypes()` that kills your entire mod assembly. RimWorld swallows the exception silently and you only see it as a flood of `Type Avatar.X is not a Def type or could not be found` errors for every def in your Defs/ folder, plus one easy-to-miss `ReflectionTypeLoadException getting types in assembly X` line in Player.log.

**Recipe:**
1. Use the version `brrainz.harmony` currently ships: **2.4.1** (RimWorld 1.6, x64 and arm64) — the same version ModMixer's live/test harness bundles. In the common case you do NOT need to inspect the DLL; pin 2.4.1 and move on. Only re-check if you have a specific reason to believe a newer Harmony shipped — and then read the assembly version *properly*. The PowerShell one-liner below is Windows-only; on macOS/Linux use `monodis --assembly '<workshop>/2009463077/Current/Assemblies/0Harmony.dll'` (or `ikdasm`) and read its `.ver`. Do NOT `strings | grep` the raw DLL for a `\d.\d.\d.\d` pattern — it embeds many unrelated version tokens (System, mscorlib, …) and you'll pick the wrong one.
   ```powershell
   # Windows only:
   [System.Reflection.AssemblyName]::GetAssemblyName('<workshop>\2009463077\Current\Assemblies\0Harmony.dll').Version
   ```
2. Pin Lib.Harmony in your csproj to that EXACT version, not a floating range:
   ```xml
   <PackageReference Include="Lib.Harmony" Version="2.4.1" ExcludeAssets="runtime">
     <IncludeAssets>compile; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
   </PackageReference>
   ```
3. Rebuild — the typeref in your DLL now matches the runtime DLL and binding succeeds.

*Why it's tricky:* `Version="2.*"` builds successfully every time, but each NuGet restore can silently bump the resolved version (e.g. when a new 2.4.2 is published). The mod works for months, then one day a routine rebuild drifts the version and **every def in your XML stops loading** with what looks like a totally unrelated XML/type error. The actual `ReflectionTypeLoadException` is buried near the top of Player.log — `grep -B2 -A30 "ReflectionTypeLoadException getting types"` is the fastest way to surface it. Don't rely on `PublicKeyToken=null` "weak binding" to paper over version drift; in practice Mono enforces the version-qualified typeref strictly here.

## Patching all overrides of an abstract method (e.g. PawnColumnWorker.DoCell across DLC/mod subclasses)

When you want to intercept calls to an abstract or virtual method across every subclass — including those defined by DLCs and other mods you don't know about at compile time — Harmony's standard `[HarmonyPatch(typeof(BaseClass), nameof(BaseClass.Method))]` does NOT work. Patching the abstract method itself does nothing because virtual dispatch goes directly to the override, never touching the abstract MethodInfo. You have to enumerate the subclasses at runtime and patch each override:

```csharp
[StaticConstructorOnStartup]
static class MyDynamicPatcher
{
    static readonly Harmony _harmony = new Harmony("yourmod.dynamic.YourPatchName");

    static MyDynamicPatcher()
    {
        var postfix = new HarmonyMethod(typeof(MyDynamicPatcher), nameof(MyPostfix));
        foreach (var type in typeof(PawnColumnWorker).AllSubclassesNonAbstract())
        {
            var method = AccessTools.Method(type, nameof(PawnColumnWorker.DoCell),
                new[] { typeof(Rect), typeof(Pawn), typeof(PawnTable) });
            if (method == null) continue;
            // CRITICAL: only patch types that DECLARE their own override.
            // Otherwise you'd patch the same inherited MethodInfo multiple times.
            if (method.DeclaringType != type) continue;
            try { _harmony.Patch(method, postfix: postfix); }
            catch (Exception ex) { Log.Warning($"Patch failed for {type.FullName}: {ex.Message}"); }
        }
    }
}
```

Key points:
- `[StaticConstructorOnStartup]` runs AFTER every mod assembly is loaded, so `GenTypes.AllSubclassesNonAbstract` (a.k.a. the extension method on `typeof(T)`) sees subclasses from every active DLC and mod.
- Use a SEPARATE Harmony instance with a unique ID so you don't conflict with the main `[HarmonyPatch]` attribute-driven patches.
- Filter on `DeclaringType != type` — otherwise a subclass that inherits the override (rather than redeclaring it) would resolve `AccessTools.Method` to the parent's MethodInfo, and you'd patch it twice (once from the parent's iteration, once from the child's).
- Wrap each `_harmony.Patch(...)` call in try/catch so one mod's weird subclass (e.g. abstract intermediary, generic type) doesn't break the rest.
- Wrap the patch body in try/catch and silently swallow — never break vanilla's per-cell drawing for a mod that's just trying to peek.

*Why it's tricky:* Harmony's documentation makes attribute-driven `[HarmonyPatch(typeof(X), …)]` feel like the only path, and "patch the abstract base method" looks like the obvious approach for catching all overrides. But abstract methods have no body to inject into — they only exist as a method table entry — so the Postfix never runs. The fix is dynamic at startup: iterate subclasses and patch each leaf override, which is also how you reach DLC/mod-added classes you don't reference at compile time.

## Closed-generic instantiation patches are still unsafe for reference-type T — even AccessTools.Method(typeof(X<RefType>),...) shares JIT code

The existing lore "Do NOT patch generic methods via MakeGenericMethod when T is a reference type" extends to **closed-generic instantiation patches via `AccessTools.Method(typeof(GenericClass<RefType>), "MethodName")`** too — not just `MakeGenericMethod` on an open method.

Concrete failure: patching `Dialog_ManagePolicies<DrugPolicy>.DoPolicyListing` AND `Dialog_ManagePolicies<ApparelPolicy>.DoPolicyListing` (etc.) — four separate `[HarmonyPatch]` classes each calling `AccessTools.Method(typeof(Dialog_ManagePolicies<TPolicy>), "DoPolicyListing")` — produces 1000s/frame of `ArrayTypeMismatchException: Attempted to access an element as a type incompatible with the array` in `Exception filling window for Dialog_ManageApparelPolicies`. The Postfix patch poisons every closed instantiation because reference-type T shares JIT codegen.

**Don't:** patch `Dialog_ManagePolicies<T>.DoPolicyListing`, `Window<T>.DoWindowContents`, or any method on a generic class where T is a reference type — even using the closed type token. The JIT code-sharing optimization causes the patch to apply across ALL T instantiations with the wrong parameter cast logic.

**Do instead:** anchor on a non-generic method that the generic method calls. For DoPolicyListing the workaround was patching `Widgets.BeginScrollView` / `Widgets.EndScrollView` (with `IsOpen` + width-based gating) to capture the outRect indirectly. Pattern: find any non-generic helper invoked from inside the generic body, patch that, and use a depth/nesting counter + window/dialog-open gate to scope the capture.

Note on attribute syntax limitation: `typeof(T).MakeByRefType()` (needed to target a `ref Vector2` parameter in `BeginScrollView`) is not a constant expression and fails CS0182 inside `[HarmonyPatch(..., new[] {...})]`. Use `[HarmonyPatch]` with a `static MethodBase TargetMethod()` body that calls `AccessTools.Method(...)` and constructs the by-ref type at runtime.

*Why it's tricky:* this looks like a closed-generic instantiation should be safe (the type is fully resolved at IL time), but Mono's shared-codegen for reference-type generics treats `Dialog_ManagePolicies<ApparelPolicy>.DoPolicyListing` and `Dialog_ManagePolicies<DrugPolicy>.DoPolicyListing` as the same body. The exception message points at `Exception filling window for RimWorld.Dialog_ManageApparelPolicies` but the root cause is the patch installed on the DrugPolicy / FoodPolicy / ReadingPolicy variants.

## When patching methods with out or ref params, declare ArgumentType.Out / Ref

**Updates an earlier note.** The Harmony attribute constructor `[HarmonyPatch(Type, string, Type[], ArgumentType[])]` is documented but unreliable in practice on RimWorld's bundled Harmony — at least with `Lib.Harmony` 2.3.3 against RimWorld 1.6.4633, the patch attribute is accepted at compile time, the DLL builds with the attribute, but at `harmony.PatchAll()` Harmony still throws `ArgumentException: Undefined target method for patch method ...` and the `WatcherMod` ctor fails wholesale via `TargetInvocationException`. ilspy can't even decode the attribute args ("Could not decode attribute arguments") which is a strong tell that something in the encoding is off.

The robust pattern is to switch from attribute targeting to `static MethodBase TargetMethod()`, which lets you build the parameter-types array at runtime with `MakeByRefType()`:

```csharp
[HarmonyPatch]
public static class Patch_RecruitSucceed
{
    static System.Reflection.MethodBase TargetMethod()
    {
        return AccessTools.Method(
            typeof(InteractionWorker_RecruitAttempt),
            "DoRecruit",
            new[] {
                typeof(Pawn), typeof(Pawn),
                typeof(string).MakeByRefType(), typeof(string).MakeByRefType(),
                typeof(bool), typeof(bool)
            });
    }

    public static void Postfix(Pawn recruiter, Pawn recruitee) { ... }
}
```

`AccessTools.Method` consumes the by-ref types correctly and resolves the overload unambiguously. Use the same pattern for `ref` params (also `MakeByRefType()`).

*Why it's tricky:* the attribute form looks correct, compiles, and the resulting DLL even *looks* fine to a manual byte inspection — but it silently fails to bind. The TargetMethod approach also doubles as the fix for `typeof(T).MakeByRefType()` being a non-constant expression (CS0182) inside attribute args.

## When patching an optional mod's methods, never use [HarmonyPatch(typeof(OptionalMod.Type))] in attributes

Use `[HarmonyPatch(typeof(X))]` only for types that are guaranteed to be loaded. For optional mods, the `typeof()` call bakes a CLR type token into the IL metadata that the runtime tries to resolve at class-load time — even when the optional mod is absent. This throws `System.TypeLoadException: Could not resolve type with token 010000xx` crashing the entire mod.

**Fix:** Apply the patch manually at startup using `AccessTools.TypeByName("OptionalMod.Type")` inside a guard (`if (!ModLister.HasActiveModWithName(...)) return;`). Use `object __instance` (not the optional type) in the patch method signature — a direct type reference there also causes the same TypeLoadException.

```csharp
public static void TryApplyHarmonyPatches(Harmony harmony)
{
    if (!ModLister.HasActiveModWithName("Optional Mod Name")) return;
    var t = AccessTools.TypeByName("OptionalMod.SomeClass");
    harmony.Patch(AccessTools.Method(t, "SomeMethod"),
        postfix: new HarmonyMethod(AccessTools.Method(typeof(MyPatches), nameof(Postfix))));
}
static void Postfix(object __instance) { /* use AccessTools.Field to read/write */ }
```

*Why it's tricky:* Harmony's `PatchAll` scans every type in the assembly and reads custom attributes. Reading `[HarmonyPatch(typeof(X))]` forces the CLR to resolve `X` immediately — before any runtime checks. This fails fatally if `X` lives in an unloaded optional mod's DLL.

## When you need to filter what vanilla iterates over, use a Harmony Prefix with `ref IEnumerable<T>` reassignment

When a vanilla method takes `IEnumerable<T> input` (NOT `ref`) and you want to feed it a filtered subset without rewriting the whole method, declare the parameter as `ref IEnumerable<T>` in your Prefix and reassign it. Harmony 2.3.x writes the modified reference back to the original method's local, and the unmodified vanilla body then iterates your substitute.

```csharp
[HarmonyPatch(typeof(GizmoGridDrawer), nameof(GizmoGridDrawer.DrawGizmoGrid))]
static class Patch_FilterArchitectGizmos
{
    static void Prefix(ref IEnumerable<Gizmo> gizmos)
    {
        if (!ShouldFilter()) return;
        gizmos = gizmos.Where(g => ShouldKeep(g));
    }
}
```

Confirmed working on `GizmoGridDrawer.DrawGizmoGrid` for the Architect Tier 2 bucket filter. The original C# signature has `IEnumerable<Gizmo> gizmos` (no `ref`); Harmony still injects IL to read back from the local after the prefix returns.

*Why it's tricky:* you'd assume reassigning a reference-type parameter in a Prefix can't propagate (C# pass-by-value semantics). Harmony's IL injection makes `ref` on the Prefix side work even when the original is by-value. Without this trick, the only alternative is to Prefix-skip the whole vanilla method and reimplement it — which for `DrawGizmoGrid` means replicating ~300 lines of sort/group/wrap/draw logic plus accessing private statics like `gizmoGroups` and `firstGizmos`. The ref-substitute is 3 lines.

Caveats: only works when the vanilla code consumes the enumerable lazily AFTER the prefix runs. If vanilla snapshots to a List before the prefix's reassignment takes effect, this fails. Verify by testing — the failure mode is "filter has no effect", not a crash.

## HarmonyPatch attribute targets DeclaredMethod, not inherited

`[HarmonyPatch(typeof(T), nameof(T.M))]` uses `AccessTools.DeclaredMethod` under the hood, which passes `BindingFlags.DeclaredOnly`. If `M` is inherited from a base class and `T` doesn't override it, Harmony throws `Undefined target method for patch method ...` at `PatchAll` time and the whole `[StaticConstructorOnStartup]` HarmonyPatches type initializer fails — taking down every patch in the assembly with a `TypeInitializationException`.

Fix: patch the base type that actually declares the method, take `BaseType __instance`, and filter at runtime with `if (!(__instance is DerivedType)) return;`. (`nameof(Derived.Method)` still compiles for inherited members, which is why this bug hides past the compiler.)

*Why it's tricky:* The runtime `AccessTools.Method` (non-attribute path) DOES walk base types, so manual `harmony.Patch(AccessTools.Method(typeof(Derived), "M"), ...)` works fine — only the attribute form is hierarchy-blind. And the failure mode is catastrophic: a single mis-targeted patch class kills every other Harmony patch in the assembly because they all run from one static cctor.

## Postfix/Prefix parameter names must match the patched method by name

Harmony binds Prefix/Postfix parameters to the original method's parameters by **name**, not by position. If your patch declares `Postfix(Rect rect, ...)` but the original is `static bool ButtonInvisible(Rect butRect, bool doMouseoverSound)`, you get `System.Exception: Parameter "rect" not found in method static System.Boolean Verse.Widgets::ButtonInvisible(...)` at `PatchAll` time — which throws inside the `[StaticConstructorOnStartup] HarmonyPatches` cctor and kills every other patch in the assembly via `TypeInitializationException`.

Common RimWorld traps: `Widgets.ButtonInvisible(Rect butRect, ...)`, `Widgets.ButtonImage(Rect butRect, Texture2D tex, ...)`, `Widgets.BeginScrollView(Rect outRect, ref Vector2 scrollPosition, Rect viewRect, ...)`. NOT named `rect`. `Widgets.ButtonText` IS `Rect rect` though, so it's per-method — always cross-check the actual vanilla signature.

Recipe: when patching anything, decompile the target method first, copy its parameter names verbatim into your Postfix signature. Don't guess. The C# compiler won't catch this — it's a runtime bind failure only.

## When patching a generic method like TabDrawer.DrawTabs, construct it explicitly with MakeGenericMethod

Harmony 2.x cannot patch open generic method definitions. Calls like `typeof(X).GetMethod("Foo")` skipping `IsGenericMethodDefinition` returns the open def; passing that to Harmony's `[HarmonyPatch]` silently fails to bind.

The fix is to construct the closed method yourself via `MakeGenericMethod(typeof(SomeConcreteType))`. For `TabDrawer.DrawTabs<TTabRecord> where TTabRecord : TabRecord`, every vanilla caller uses `List<TabRecord>` directly (no subclasses), so:

```csharp
static MethodBase TargetMethod()
{
    foreach (var m in typeof(TabDrawer).GetMethods(BindingFlags.Public | BindingFlags.Static))
    {
        if (m.Name != "DrawTabs") continue;
        if (!m.IsGenericMethodDefinition) continue;
        var p = m.GetParameters();
        if (p.Length == 3 && p[0].ParameterType == typeof(Rect))
            return m.MakeGenericMethod(typeof(TabRecord));
    }
    return null;
}
```

*Why it's tricky:* A "find method by name + first-param type" reflection helper that filters out generic method definitions for safety (a common pattern) will reject ALL DrawTabs overloads, since all 3 are generic. The error surface — "Patch target not found" — looks like a version drift but is actually a missing MakeGenericMethod call.

## Widgets.RadioButton has NO (Rect, bool, bool) overload — patch ButtonInvisible instead

Vanilla `Widgets.RadioButton` only exposes `(Vector2, bool, bool)` and `(float, float, bool, bool)`. Both internally call `Widgets.ButtonInvisible(butRect)` with the 24×24 indicator rect. `Widgets.RadioButtonLabeled(Rect, ...)` also forwards to `ButtonInvisible(rect)`. So a single Postfix on `Widgets.ButtonInvisible` captures every radio-button click — do not try to `HarmonyPatch(typeof(Widgets), nameof(Widgets.RadioButton), new[] { typeof(Rect), typeof(bool), typeof(bool) })`, it'll throw at static-ctor time: `Undefined target method for patch method ...`.

*Why it's tricky:* The name "RadioButton" + a rect parameter sounds like it should exist (every other widget has an overload). It doesn't. Verify signatures with `search_source "public static bool RadioButton\("` in `**/Verse/Widgets.cs` before patching.

## Do NOT patch generic methods via MakeGenericMethod when T is a reference type — shared JIT codegen will crash every other instantiation

**Updates the earlier "MakeGenericMethod" lesson — that pattern is broken for reference types and should be avoided.**

In .NET, generic methods with reference-type T arguments share their JIT'd machine code across instantiations (code sharing optimization). When you do:

```csharp
var m = openGeneric.MakeGenericMethod(typeof(TabRecord));
harmony.Patch(m, postfix: ...);
```

Harmony attaches the patch to that shared body. The JIT then enters the patched body for **every** reference-type instantiation (`DrawTabs<TabRecord>`, `DrawTabs<ResearchTabRecord>`, `DrawTabs<InfoCardTab>`, …) — but the patched prologue's parameter capture/cast logic is typed to `T = TabRecord`. When the actual call uses `T = ResearchTabRecord`, the cast `List<ResearchTabRecord>` → `List<TabRecord>` throws `InvalidCastException`.

Symptom: every frame, "Exception filling window for X: System.InvalidCastException: Specified cast is not valid" with thousands of occurrences, deduped to a `[Ref XXXX]` line so you can't see the actual stack. Crash is invisible at startup — only fires when a window using the wrong T instantiation renders.

**Don't:** patch `Widgets.HorizontalSlider<T>`, `TabDrawer.DrawTabs<T>`, `Widgets.TextFieldNumeric<T>`, or any other generic method via MakeGenericMethod.

**Do instead:** if you must observe a generic method, find a non-generic helper it calls (e.g. `TabRecord.Draw`, `Widgets.ButtonInvisible` inside `DrawTabs`) and patch that. Or accept that you can't observe all instantiations and disable the patch gracefully (`PatchGuard.Disable + NoOpSentinel`).

*Why it's tricky:* It compiles. It runs at startup. The patch binds successfully via PatchAll. The crash only appears when *some other* part of the game uses a non-TabRecord T — at which point you get 1000s of exceptions per frame in a vanilla window with a stack trace pointing at the vanilla code, not your patch. The Harmony docs do not warn about this. `Widgets.TextFieldNumeric<int/float/long>` in the Claude proj has the same footgun but happens not to crash because real callers happen to use those exact types.

## When Harmony-patching a private method, use string targeting not nameof

`[HarmonyPatch(typeof(Pawn_HealthTracker), nameof(Pawn_HealthTracker.MakeDowned))]` fails to compile with `CS0117: 'Pawn_HealthTracker' does not contain a definition for 'MakeDowned'` when the target method is private — `nameof` requires the symbol to be accessible from the caller. Switch to string targeting: `[HarmonyPatch(typeof(Pawn_HealthTracker), "MakeDowned")]`. Harmony itself reaches private members via reflection just fine.

*Why it's tricky:* the error message blames the type for not having the definition, not the visibility, so it looks like an API rename when it's just C# accessibility.

## When patching an overloaded vanilla method, ALL parameter types must be listed or Harmony throws "Undefined target method" at startup

Harmony's `[HarmonyPatch(typeof(T), nameof(T.X), new[] { typeof(A), typeof(B) })]` only matches the overload whose parameter list **exactly equals** the supplied type array, including optional parameters that have defaults.

Example failure: `LetterStack.ReceiveLetter`'s "letter" overload is `ReceiveLetter(Letter let, string debugInfo = null, int delayTicks = 0, bool playSound = true)`. Specifying `new[] { typeof(Letter), typeof(string) }` matches **zero** overloads because vanilla has no two-arg version — the optional `int`/`bool` parameters are still part of the signature. At startup you get:

```
HarmonyLib.HarmonyException: Patching exception in method null
---> System.ArgumentException: Undefined target method for patch method static System.Void MyMod::Patch_X(...)
```

…thrown from the static constructor, which kills `HarmonyPatches`' static ctor entirely (`TypeInitializationException`), and the whole mod fails to load.

Fix: open the vanilla source, find the FULL signature, list every parameter type:
```csharp
[HarmonyPatch(typeof(LetterStack), nameof(LetterStack.ReceiveLetter),
    new[] { typeof(Letter), typeof(string), typeof(int), typeof(bool) })]
```

Same trap: `IncidentQueue.Add(QueuedIncident)` vs `Add(IncidentDef, int, IncidentParms, int)` — you must pick the right one AND list all its types.

*Why it's tricky:* the patch attribute compiles fine; the failure only surfaces at runtime during `Harmony.PatchAll`. Worse, one failed patch aborts the WHOLE class's PatchAll, so a second wrong signature later in the same class never even gets to throw its own error — you'll fix the first one only to immediately get the second on relaunch.

## HarmonyPatch on a virtual method works only if the named type actually overrides it

`[HarmonyPatch(typeof(Derived), nameof(Derived.SomeVirtual))]` requires `Derived` to actually declare/override `SomeVirtual`. If only the base declares it (and `Derived` just inherits), Harmony fails with `Undefined target method for patch method ... ::Postfix` and the static constructor of your patch class throws `TypeInitializationException` at startup — wrecks the whole mod load. Common RimWorld traps: `MainTabWindow_Work` does NOT override `PreOpen` or `RequestedTabSize` (both on `MainTabWindow_PawnTable` / `Window`); `MainTabWindow_Architect` DOES override `PreOpen` and `RequestedTabSize`, so it works.

Fix: patch the **declaring** type (`Window.PreOpen`, `MainTabWindow_PawnTable.RequestedTabSize`) and gate the Postfix on `__instance is YourTargetType`. The gate is one is-check per call; cheap.

*Why it's tricky:* "but MainTabWindow_Work has PreOpen at runtime — I can call it!" — yes, because it inherits. Inheritance ≠ declaration. Harmony reflects on the type literally, looking for a `MethodInfo` declared on that type. Inherited members aren't found.

## When patching frequently-called methods, gate the patch body on settings + early-return on common cases at the very top

A Harmony patch on a hot-path method (e.g. `Hediff.Tick`, `DamageWorker.Apply`, `Pawn.Tick`) runs FAR more often than the modder usually pictures. `Hediff.Tick` fires once per hediff per pawn per game tick — easily 5000+ calls/sec mid-game. If your patch body does anything substantive (allocates, calls reflection, dereferences nested optionals), the game stutters.

Recipe:
1. **First line of the patch body is a `if (!settings.featureEnabled) return;`** — a single bool read costs nothing.
2. **Second line is the type-narrowing guard** — `if (!(victim is Pawn p) || !p.IsColonistPlayerControlled) return;` etc. — so the bulk of calls (damage to plants, hediffs on raiders) short-circuit before any real work.
3. **Never** put a Harmony patch on `Hediff.Tick`/`Pawn.Tick`/`ThingWithComps.Tick` unless you've measured the cost. There's almost always a less-hot event you can hook instead — `Pawn_HealthTracker.NotifyPlayerOfKilled` (one fire per pawn death) beats `Hediff.Tick` for "pawn died" haptics by 5 orders of magnitude.

*Why it's tricky:* the patch itself looks tiny in source — a reflection call here, a property dereference there. None of those operations are "expensive" in isolation. The cost is the **call count**, which you only learn from a profile. Once a hot-path patch ships, players report inexplicable stutter that no Player.log error explains.

## When calling vanilla methods via Traverse.Method, pass exact param types — TaggedString silently breaks string-arg lookups

`Traverse.Create(obj).Method("Name", args...).GetValue()` matches the target method by NAME + EXACT runtime types of `args`. C# implicit conversions (like `TaggedString → string`) are NOT applied to the match. When the lookup fails Traverse returns an empty Traverse and `GetValue()` is a silent no-op — no exception, no log message. The code "runs" but does nothing.

Concrete trap: `Traverse.Create(page).Method("DoBottomButtons", inRect, null, "Edit".Translate(), action, true, true)` looks for `DoBottomButtons(Rect, ?, TaggedString, Action, bool, bool)` — doesn't exist (vanilla takes `string` for label). Silent no-op = no bottom buttons rendered.

Fix: either `.ToString()` the TaggedString, or skip Traverse entirely and call your own static helper directly when the logic is yours to control.

*Why it's tricky:* The standard `string label = "X".Translate();` pattern works everywhere ELSE in modding code because the C# compiler inserts the implicit conversion at the call site. Traverse bypasses the compiler — it uses runtime type lookup. So this fails ONLY through Traverse, and fails silently, so it can look like "method call succeeded but had no effect" rather than "method call didn't happen".

## Constraining where AI pawns can go: patch Reachability.CanReach, not job/target consumers

When you need to forbid a class of pawns from going to certain cells (e.g. only roofed cells during a hazard), do NOT try to filter at the consumer level. RimWorld has dozens of AI subsystems that pick targets/destinations independently — `JobGiver_AIFightEnemy`, `TrashUtility.ShouldTrashBuilding`, `JobGiver_AIGotoNearestHostile`, `JobGiver_AISapper`, `JobGiver_AIDefendPoint`, lord-set duty.focus cells, breaching, infestations, escort, hunt, patrol, etc. Patching them one by one is whack-a-mole — there is always one more.

**Patch `Reachability.CanReach(IntVec3, LocalTargetInfo, PathEndMode, TraverseParms)` instead.** Every AI consumer ultimately funnels through it (or through the pathfinder, which calls it). Return `__result = false` for forbidden destinations and the entire AI stack naturally drops those targets from candidate sets. Vanilla AI runs untouched; you only narrow the reachable set.

```csharp
[HarmonyPatch(typeof(Reachability), nameof(Reachability.CanReach),
    new System.Type[] { typeof(IntVec3), typeof(LocalTargetInfo),
        typeof(PathEndMode), typeof(TraverseParms) })]
static class Patch {
    static bool Prefix(Reachability __instance, IntVec3 start,
                      LocalTargetInfo dest, TraverseParms traverseParams,
                      ref bool __result) {
        if (!ShouldConstrain) return true;
        Pawn pawn = traverseParams.pawn;
        if (pawn == null || pawn.IsColonist) return true; // exempt
        Map map = Traverse.Create(__instance).Field<Map>("map").Value;
        if (map == null) return true;
        if (!IsForbiddenZone(map, dest.Cell)) return true;
        __result = false;
        return false;
    }
}
```

*Why it's tricky:* the obvious approach is to patch `AttackTargetFinder.BestAttackTarget` (which has a Predicate<Thing> validator slot, so it looks designed for this). It works for combat but misses building trash, lord focus, escort, etc. — each of those does its own target picking with its own validator. Reachability is the common denominator.

*Equally important:* do NOT patch `Pawn_PathFollower.StartPath` to deny outdoor paths — calling `EndCurrentJob` from inside it is reentrant and corrupts the pather state, freezing pawns. And do NOT patch `Pawn_JobTracker.StartJob` to filter jobs — vanilla AI emits dozens of intermediate Wait/Goto/idle jobs that you can't safely deny without breaking the think tree.

*Also:* if the constrained pawn type ends up in a custom infinite-loop "stay here" job (e.g. a SeekShelter wander loop), the `Pawn_JobTracker.CheckForJobOverride` only runs the constant think tree mid-job — `JobGiver_AIFightEnemy` lives in the main think tree. So the pawn will never start combat while in your job. End your custom job once the pawn satisfies your constraint, then vanilla AI's main think tree fires and combat works normally.

## When patching RimWorld 1.6 ideology style methods, use these exact signatures

In RimWorld 1.6, the style API changed significantly from 1.5:

- `Pawn_StyleTracker.StyleCategory` **does not exist**. The property was removed entirely.
- `IdeoStyleTracker.StyleForThingDef` is the correct interception point for both pawn items (hair/beard/tattoos) and thing styles. Its exact signature is: `StyleCategoryPair StyleForThingDef(ThingDef thing, Precept precept)` — note the return type is `StyleCategoryPair` (not `ThingStyleDef`), and the parameter is named `thing` (not `thingDef`). Use a Postfix; mutate `ref StyleCategoryPair __result` by boxing, setting fields by type, then unboxing.
- `CompStyleable` has a property `StyleCategoryDef` (not `StyleDef`). The backing field is `styleDef` (lowercase).
- `Faction.ideos` is a **field** (not a property like `ideoTracker`). Its container type is unknown at compile time — use reflection to iterate it as `IEnumerable` to get the first `Ideo`.
- `Ideo.style` is a field of type `IdeoStyleTracker` (not `StyleCategoryDef`).
- `StyleCategoryPair` fields: find by type (`StyleCategoryDef` and `ThingStyleDef`) rather than by name to avoid breaking across versions.

*Why it's tricky:* Between 1.5 and 1.6 Ludeon restructured the ideology style system, renaming and removing members. `PatchAll` throws `HarmonyException: Patching exception in method null` when any `[HarmonyPatch]` attribute targets a non-existent property getter — crashing the entire mod constructor silently from RimWorld's perspective.

## When a Postfix mutates ref __result via reflection, handle the null case

If the patched method returns a reference type, `__result` can be null — and `FieldInfo.SetValue(null, …)` throws `TargetException: Non-static field requires a target`. Always check `if (box == null) box = Activator.CreateInstance(targetType);` before calling SetValue. This bites especially when patching ideology lookup methods like `IdeoStyleTracker.StyleForThingDef`, which return null for any ThingDef the ideology doesn't have a style entry for — extremely common during pawn generation. *Why it's tricky:* the error says "non-static field" but the fields ARE instance — the missing piece is that the *target* (the boxed instance) is null.

## In RimWorld 1.5+, hide a pawn's rendering by patching DynamicDrawPhaseAt, not DrawAt

A Harmony prefix on `Pawn.DrawAt` returning `false` no longer hides the pawn in 1.5+. Pawn rendering goes through `Pawn.DynamicDrawPhaseAt(DrawPhase, Vector3, bool)`, which dispatches the three phases (PreDraw / ParallelPreDraw / Draw). Patch this instead:

```csharp
[HarmonyPatch(typeof(Pawn), nameof(Pawn.DynamicDrawPhaseAt))]
public static class Patch { public static bool Prefix(Pawn __instance) => !ShouldHide(__instance); }
```

Unlike `DrawAt`, `DynamicDrawPhaseAt` is public so `nameof` works directly (no string overload needed).

*Why it's tricky:* compile + Harmony patch both succeed silently with `DrawAt`; the pawn just keeps rendering because the new pipeline doesn't go through it. The clue is in `Assembly-CSharp.dll`: `strings | grep` for `DynamicDrawPhaseAt` and `RenderPawnInternal` and you'll see those, plus `ParallelPreRenderPawnAt` — the pre-1.5 `DrawAt` path is essentially vestigial for pawns.

## 1.4 → 1.6 ritual API renames: OutcomeChance → RitualOutcomePossibility, ExpectedOutcomeDesc → QualityFactor

When porting Ideology ritual code from 1.4 to 1.5/1.6, four overrides shifted:

- `RitualOutcomeEffectWorker_FromQuality.ApplyExtraOutcome(..., OutcomeChance outcome, ...)` → `..., RitualOutcomePossibility outcome, ...`. Same shape, just renamed.
- `RitualOutcomeComp_Quality.GetExpectedOutcomeDesc(...)` returning `ExpectedOutcomeDesc` → `RitualOutcomeComp.GetQualityFactor(...)` returning `QualityFactor`. The field `effect` on the return value was renamed to `qualityChange`; other fields (label/count/quality/positive/priority) carry over.

*Why it's tricky:* Harmony patches against `ApplyExtraOutcome` by name still work because Harmony resolves the method by `MethodInfo` after the type change, but **subclass overrides** silently no-op (CS0115: no suitable method found to override) — the only signal is a build error pointing at the old return type. Both renames are pure renames with no logic change, so the fix is mechanical once you know what to search for.
