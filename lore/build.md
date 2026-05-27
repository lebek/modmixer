## RimWorld build conventions: net472, ReferenceAssemblies, no shipped Unity DLLs

When scaffolding or fixing a `.csproj` for a RimWorld mod:

- **Target framework: `net472`.** RimWorld runs on Unity Mono with the .NET Framework 4.7.2 surface across versions 1.4 / 1.5 / 1.6. Do NOT use `netstandard2.0` — RimWorld 1.6's `Assembly-CSharp` targets `netstandard2.1` and the mismatch surfaces as a build-time version conflict.
- **Cross-platform builds:** include `<PackageReference Include="Microsoft.NETFramework.ReferenceAssemblies" Version="1.0.3" PrivateAssets="all" />` so the compile works on Linux/macOS dev boxes that don't have the .NET Framework targeting pack installed.
- **Reference Assembly-CSharp / UnityEngine DLLs from the user's install** via `<Reference><HintPath>` with `<Private>false</Private>`. `<Private>false</Private>` is what stops MSBuild from copying those DLLs into your `Assemblies/` and shipping them.
- **Output path: `..\Assemblies\`** (relative to `Source/`). RimWorld scans `<ModFolder>/Assemblies/*.dll` at load — the project must compile directly into that folder.

*Why it's tricky:* most generic .NET tutorials default to `netstandard` or `net6.0`, both of which silently break against Unity Mono. Default `<Private>true</Private>` would also dump UnityEngine DLLs into your mod, causing version conflicts with the running game.

## `CS1061` / `CS0246` from a missing `using` — RimWorld splits APIs across sub-namespaces

When a method or type "should exist" but the compiler insists it doesn't, the type is usually in a sub-namespace that `using RimWorld; using Verse;` doesn't pull in. The pattern is `error CS1061: '<Type>' does not contain a definition for '<Member>' and no accessible extension method` (extension methods) or `CS0246: The type or namespace name '<Name>' could not be found` (plain types). Add the right `using` instead of fishing in the existing namespaces.

Most-bitten cases:

| Symbol | Lives in | Notes |
| --- | --- | --- |
| `Pawn.IsWorldPawn()`, `Find.WorldPawns`, `Caravan`, `Settlement`, `WorldObject`, `Tile` | `RimWorld.Planet` | Anything off the planet/world map. |
| `QuestNode`, `QuestNode_*`, `QuestPart_*`, `QuestGen`, `Slate` | `RimWorld.QuestGen` | Quest scripting. The QuestPart base is in `RimWorld`, but QuestPart_<Subclass> is in QuestGen. |
| `JobDriver`, `JobDriver_*`, `Toils_*`, `ThinkNode`, `ThinkNode_*`, `WorkGiver_*`, `MentalState_*`, `Pawn_PathFollower` | `Verse.AI` | All pawn AI / job execution. Easy to miss because `JobDef` itself is in `Verse`. |
| `SoundDef`, `SubSoundDef`, `Sustainer`, `SoundInfo`, `SoundDefOf` | `Verse.Sound` | `SoundDefOf` is the trap — looks like it should be in `RimWorld` alongside other `*DefOf`. |
| `Texture2D`, `Color`, `Vector2/3`, `Rect`, `Mathf`, `Time.deltaTime`, `GUI.*`, `TextAnchor` | `UnityEngine` | `Mathf.Clamp/Min/Max/RoundToInt/Lerp` is the most-bitten — `System.Math` covers some but not all of it (no `Lerp`, no float `Clamp` in net472). And `TextAnchor` also needs the `UnityEngine.TextRenderingModule` reference (next entry). |
| `Sketch`, `SketchEntity_*`, `SketchResolverDef` | `RimWorld.SketchGen` | Procedural building generation. |
| `SymbolDef`, `SymbolResolver_*`, `BaseGenUtility` | `RimWorld.BaseGen` | Base/raid scenario generation. |

When in doubt, run `search_source <SymbolName>` and look at the file path of the *declaration* (e.g. `Verse.AI\MentalStateWorker.cs`) — the path segment before the filename is the namespace.

*Why it's tricky:* RimWorld's namespace split is not aligned with what the type does. `JobDef` is in `Verse` but everything that *uses* it is in `Verse.AI`. `WorldPawnsUtility` (which defines the `IsWorldPawn` extension) is in `RimWorld.Planet` even though the extended type (`Pawn`) is in `Verse`. Adding `using Verse;` and `using RimWorld;` does not transitively pull in their child namespaces.

## `CS0012: 'TextAnchor' is defined in an assembly that is not referenced` — add UnityEngine.TextRenderingModule

When you call `Widgets.ButtonText` (or anything taking a `TextAnchor?` overload) and hit CS0012, add this to the csproj:

```xml
<Reference Include="UnityEngine.TextRenderingModule">
  <HintPath>$(RimWorldRoot)\..\UnityEngine.TextRenderingModule.dll</HintPath>
  <Private>false</Private>
</Reference>
```

*Why it's tricky:* most mods only reference `UnityEngine.CoreModule`. Code compiles fine until you actually invoke the overload that pulls in `TextAnchor`, then CS0012 fires.

## Add `UnityEngine.IMGUIModule.dll` reference when using `GUI` / `GUIContent` (Widgets.Label needs it)

If your mod uses any `GUI.*` (like `GUI.color = ...`) or even calls `Widgets.Label(rect, string)` from a MainTabWindow / Window, you'll hit `CS0012: The type 'GUIContent' is defined in an assembly that is not referenced. You must add a reference to assembly 'UnityEngine.IMGUIModule'`. The vanilla `Widgets.Label` overload allocates a `GUIContent` internally so it transitively pulls in IMGUI.

Fix — add to the csproj:

```xml
<Reference Include="UnityEngine.IMGUIModule">
  <HintPath>$(RimWorldRoot)\..\UnityEngine.IMGUIModule.dll</HintPath>
  <Private>false</Private>
</Reference>
```

*Why it's tricky:* `UnityEngine.dll` and `UnityEngine.CoreModule.dll` are not enough. Unity split IMGUI into its own assembly; the type appears in your stack only via referenced overloads, so the error fires even when *you* never name `GUI` or `GUIContent`.

## Referencing a mod DLL built against a higher TFM — set ResolveAssemblyReferenceIgnoreTargetFrameworkAttributeVersionMismatch

Some installed mods (e.g. RimTalk) ship `net4.8`-targeted DLLs. If your mod's csproj is `net4.7.2` (the RimWorld convention) and you `<Reference>` that DLL, MSBuild's ref-assembly check throws MSB3274/MSB3275 ("could not be resolved because it was built against a higher framework") and silently drops the reference — every type from it becomes CS0246 even though the file path is correct.

Fix in the csproj `<PropertyGroup>`:

```xml
<ResolveAssemblyReferenceIgnoreTargetFrameworkAttributeVersionMismatch>true</ResolveAssemblyReferenceIgnoreTargetFrameworkAttributeVersionMismatch>
<NoWarn>MSB3274;MSB3275</NoWarn>
```

This forces MSBuild to honor the reference. Safe at runtime because Unity Mono is the same regardless of which net4.x TFM the DLL was authored against — `net4.7.2` and `net4.8` produce IL-compatible assemblies and the Mono runtime in RimWorld supports both API surfaces.

*Why it's tricky:* the CS0246 errors point at your code, not at MSBuild's framework check. The cause is buried in the build log as a *warning* (MSB3274), not an error, and looks innocuous. You can chase missing `using` directives and assembly-paths for a long time before realising the reference simply isn't being included.

## MapComponent.FinalizeInit runs on a background thread during map generation — do NOT call Unity graphics APIs there

`MapComponent.FinalizeInit()` is called from `Map.FinalizeInit()` which runs inside `LongEventHandler.RunEventFromAnotherThread` during map generation. This means it executes on a background thread, NOT the Unity main thread.

**Any Unity graphics API call from FinalizeInit will cause a native crash:** `new Texture2D(...)`, `new Material(...)`, `Shader.Find(...)`, `GameObject.AddComponent(...)`, etc. The crash signature is `Texture2D:Internal_CreateImpl` in the stack trace with `LongEventHandler:RunEventFromAnotherThread` further up.

**Fix:** defer all Unity API calls to `MapComponentUpdate()` or `MapComponentDraw()` (both run on the main thread). Use a `bool graphicsInitialized` flag for lazy one-shot init:

```csharp
public override void FinalizeInit()
{
    // Pure data setup only — safe on any thread
    field = new MyDataStructure();
}

public override void MapComponentUpdate()
{
    if (!graphicsInitialized)
        TryInitGraphics(); // Texture2D, Material, Shader.Find here
    // ...
}
```

*Why it's tricky:* the crash is a native Unity crash (`Got a UNKNOWN while executing native code`), not a clean C# exception. The stack trace shows `Mono JIT Code` mixed with `UnityPlayer` native frames, and the crash handler logs it as a `unityplayer.dll` crash. Easy to misattribute to GPU drivers or Unity bugs when it's actually a threading violation.

## Mod constructor runs on a background thread via LongEventHandler — do NOT call Unity graphics APIs (Shader.Find, new Material, Texture2D, etc.) there

The Mod constructor (`Mod(ModContentPack)`) is called from `LoadedModManager.CreateModClasses()` which runs inside `PlayDataLoader.DoPlayLoad()` → `LongEventHandler.RunEventFromAnotherThread`. This means the Mod constructor executes on a background thread, NOT the Unity main thread.

Any Unity graphics API call from the constructor will cause a native Unity crash:
- `Shader.Find(...)` → crash in `ResourcesAPIInternal:FindShaderByName`
- `new Material(...)`
- `new Texture2D(...)`
- `GameObject.AddComponent(...)`

The crash stack trace signature: `LongEventHandler:RunEventFromAnotherThread → PlayDataLoader:DoPlayLoad → LoadedModManager:CreateModClasses → Mod.ctor` with a native crash in `UnityEngine.ResourcesAPIInternal:FindShaderByName` or similar.

Fix: defer all Unity API calls to the first render frame (`Camera.onPostRender`), `MapComponentUpdate()`, or `MapComponentDraw()` — all of which run on the main thread. Use a lazy-init flag pattern.

*Why it's tricky:* it's a native Unity crash (`ERROR: SymGetSymFromAddr64` in UnityPlayer), not a managed exception. The managed stack trace shows `Mono JIT Code` mixed with `UnityPlayer` native frames. Nothing in the log says "called off main thread" — you have to spot `RunEventFromAnotherThread` in the trace.

## To inspect a 1.x RimWorld type, use `decompile_dll`, never bash-invoke `ilspycmd`

The in-app `decompile_dll` tool runs ilspycmd through a path-policy guard. Bash-invoking `ilspycmd` triggers a permission prompt AND current upstream packages have a broken `DotnetToolSettings.xml` that fails `dotnet tool install`.

*Why it's tricky:* if `decompile_dll type=TypeName` returns "Could not find type definition", call `decompile_dll listTypes=true` to dump every class/struct/enum in the assembly (~5KB even for big mods) — type names rarely match what you'd guess. Patches are typically named like `MyMod.MainTabWindowWork_DoWindowContents_Patch` with idiosyncratic underscoring, and `WeatherOverlay_Rain` lives in `RimWorld` not `Verse`. Calling `decompile_dll` with neither `type` nor `listTypes` on a large assembly auto-falls-back to the type list rather than dumping 100KB of unrelated code.
