# Harmony prefix and postfix patches

> **Reference** — Harmony 2.x, stable. See `overview.md` for when to patch at
> all and `argument-injection.md` for the full set of injectable parameters.

## Postfix — the safe default

A postfix runs after the original. Reach for it first: it can't break the
original's logic, only observe or adjust the result.

```csharp
[HarmonyPatch(typeof(StatExtension), nameof(StatExtension.GetStatValue))]
public static class GetStatValue_Patch
{
    // __result is the original's return value, by ref — assign to change it.
    public static void Postfix(ref float __result, Thing thing, StatDef stat)
    {
        if (stat == StatDefOf.MoveSpeed && thing is Pawn p && IsOurPawn(p))
            __result *= 1.5f;
    }
}
```

- `__result` (ref) — the return value. Omit it if you only need a side effect.
- A postfix may also be declared to *return* the same type it patches; Harmony
  passes `__result` in and uses your return as the new result. The `ref`
  parameter form above is the common one.
- A postfix on a void method just takes whatever parameters it needs.

## Prefix — when you must run before, or skip the original

A prefix runs before the original. Declared `void`, it just runs first.
Declared **`bool`**, returning `false` **skips the original method entirely**
(and skips other prefixes that haven't run); returning `true` lets it proceed.

```csharp
[HarmonyPatch(typeof(Pawn), nameof(Pawn.ClearMind_NewTemp))]
public static class ClearMind_Patch
{
    // Return false to suppress the original ClearMind for our pawns.
    public static bool Prefix(Pawn __instance, bool wasDowned)
    {
        if (wasDowned && IsOurPawn(__instance))
            return false;   // original ClearMind does NOT run
        return true;        // everyone else: proceed normally
    }
}
```

When a skipping prefix suppresses a non-void method, set `ref __result` to the
value the caller should see, otherwise it gets `default`.

## Choosing prefix vs postfix

- Need to **observe or tweak the result** → postfix.
- Need to **change the inputs** before the original sees them → prefix (mutate
  the `ref` parameter, return `true`).
- Need to **conditionally cancel** the original → `bool` prefix returning
  `false` for the cancel case.
- Default to postfix. A `bool` prefix that returns `false` is the most
  invasive patch shape — it can starve other mods' prefixes and replace engine
  behavior wholesale.

## Gotchas

- **Multiple mods patching the same method**: a `false`-returning prefix can
  prevent other mods' prefixes and the original from running. Don't cancel the
  original unless you genuinely mean "this method no longer does its job."
- A `bool` prefix's return type controls skipping; **don't accidentally type a
  prefix `bool`** if you didn't mean to gate the original — a stray `return`
  then silently suppresses engine code.
- Parameter names must match the original method's parameter names exactly
  (Harmony binds by name) — see `argument-injection.md`.
- Patches don't apply to already-JITed inlined calls; a tiny method the JIT
  inlined may not be hit. If a patch "doesn't fire," suspect inlining.
