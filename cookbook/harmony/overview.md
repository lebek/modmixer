# Harmony patching: what it is and when to reach for it

> **Reference** — Harmony 2.x API, stable across RimWorld 1.4–1.6. The API
> itself rarely changes; this page is safe to trust. For the *project setup*
> (csproj `Lib.Harmony` reference, About.xml `brrainz.harmony` dependency, and
> the "never ship 0Harmony.dll" trap) see `[[harmony]]` lore first — that is
> the load-bearing gotcha and it is not repeated here.

## What Harmony does

Harmony rewrites methods at runtime. You can't change RimWorld's compiled
`Assembly-CSharp.dll`, but you can attach your code to its methods:

- **prefix** — runs before the original; can inspect/replace args or skip the
  original entirely.
- **postfix** — runs after the original; can read and rewrite the return value.
- **transpiler** — rewrites the original's IL instruction stream.
- **finalizer** — runs even if the original threw; for cleanup / exception
  swallowing.

## When NOT to use Harmony

Harmony is powerful and brittle — it couples your mod to engine internals that
can shift between RimWorld versions. Before patching, check for a
non-Harmony seam:

- **New content** (items, buildings, recipes, incidents) → Def XML, no Harmony.
- **Per-tick map-scoped logic** → subclass `MapComponent` (see `[[harmony]]`
  lore — this is a common mis-reach for Harmony).
- **Extra data/behavior on a thing** → a `ThingComp` via `<comps>`.
- **Reacting to a stat** → a `StatPart`.
- **Custom AI** → a `JobDriver` / `ThinkNode` / `WorkGiver`.

Reach for Harmony only when the behavior you need has no XML or subclass seam —
i.e. you must change what an *existing engine method* does.

## Anatomy of a patch class

```csharp
using HarmonyLib;
using Verse;

[StaticConstructorOnStartup]
public static class MyMod
{
    static MyMod()
    {
        var harmony = new Harmony("yourname.yourmod");
        harmony.PatchAll();   // discovers every [HarmonyPatch] in this assembly
    }
}

[HarmonyPatch(typeof(Pawn_HealthTracker), nameof(Pawn_HealthTracker.MakeDowned))]
public static class Pawn_MakeDowned_Patch
{
    public static void Postfix(Pawn ___pawn)
    {
        // runs after every MakeDowned call
    }
}
```

`PatchAll()` scans the calling assembly for `[HarmonyPatch]`-annotated classes
and wires up any `Prefix`/`Postfix`/`Transpiler`/`Finalizer` method it finds.
The Harmony id string just needs to be unique per mod.

See `prefix-postfix.md` for the prefix/postfix patterns, `argument-injection.md`
for how to receive `__instance` / `__result` / private fields, and
`transpiler.md` for IL rewriting.
