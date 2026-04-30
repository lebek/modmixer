## `CS0012: 'TextAnchor' is defined in an assembly that is not referenced` — add UnityEngine.TextRenderingModule

When you call `Widgets.ButtonText` (or anything taking a `TextAnchor?` overload) and hit CS0012, add this to the csproj:

```xml
<Reference Include="UnityEngine.TextRenderingModule">
  <HintPath>$(RimWorldRoot)\..\UnityEngine.TextRenderingModule.dll</HintPath>
  <Private>false</Private>
</Reference>
```

*Why it's tricky:* most mods only reference `UnityEngine.CoreModule`. Code compiles fine until you actually invoke the overload that pulls in `TextAnchor`, then CS0012 fires.

## To inspect a 1.x RimWorld type, use `decompile_dll`, never bash-invoke `ilspycmd`

The in-app `decompile_dll` tool runs ilspycmd through a path-policy guard. Bash-invoking `ilspycmd` triggers a permission prompt AND current upstream packages have a broken `DotnetToolSettings.xml` that fails `dotnet tool install`.

*Why it's tricky:* if `decompile_dll -t TypeName` returns "Could not find type definition", grep the dump for the namespace first — `WeatherOverlay_Rain` lives in `RimWorld`, not `Verse`, etc.
