# Harmony argument injection and patch targeting

> **Reference** — Harmony 2.x, stable. See `prefix-postfix.md` for the
> prefix/postfix patterns these parameters plug into.

## Injected parameters

Harmony binds your patch method's parameters **by name**. Special names give
you access to the original call's context:

| Parameter | What you get |
| --- | --- |
| `__instance` | The object the method was called on (omit for static methods). |
| `__result` | The return value. `ref` to change it (postfix) or set it from a skipping prefix. |
| `__state` | A scratch value passed prefix → postfix on the *same* call. Prefix sets it, postfix reads it. |
| `___fieldName` | A private *field* of the instance (three leading underscores). `ref` to write it. For a property, use its backing field name — see the gotcha below. |
| `__args` | `object[]` of all arguments — rarely needed; prefer naming them. |
| `__exception` | Finalizers only — the exception the original threw, or `null`. Return `null` from the finalizer to swallow it. |
| `__originalMethod` | The `MethodBase` being patched — useful when one patch class targets several methods. |
| `__runOriginal` | Readonly `bool` — whether the original has run / will run (`false` once a prefix has skipped it). |
| a name matching an original parameter | That argument. Add `ref` to mutate it (prefix). Type must match. |

```csharp
public static void Postfix(
    Pawn __instance,            // the pawn
    ref bool __result,          // method's return value
    ThingDef ___lastUsedDef,    // a private field on Pawn
    int radius)                 // a real parameter of the original method
{ ... }
```

`__state` carries data between a prefix and postfix on one invocation:

```csharp
public static void Prefix(Pawn __instance, out float __state)
    => __state = __instance.health.summaryHealth.SummaryHealthPercent;
public static void Postfix(Pawn __instance, float __state)
{
    // compare post-call health against __state captured pre-call
}
```

## Targeting the right method

```csharp
// By type + method name (use nameof so a rename is a compile error):
[HarmonyPatch(typeof(Pawn), nameof(Pawn.GetGizmos))]

// Overloaded method — disambiguate by argument types:
[HarmonyPatch(typeof(GenSpawn), nameof(GenSpawn.Spawn),
    new[] { typeof(ThingDef), typeof(IntVec3), typeof(Map) })]

// Property getter / setter:
[HarmonyPatch(typeof(Pawn), nameof(Pawn.IsColonist), MethodType.Getter)]

// Constructor:
[HarmonyPatch(typeof(Pawn), MethodType.Constructor, new Type[0])]
```

For a private/internal/nested type Harmony can't reference at compile time,
target it with `AccessTools`:

```csharp
[HarmonyPatch]
public static class Patch
{
    static MethodBase TargetMethod()
        => AccessTools.Method("RimWorld.SomeInternalClass:DoThing");
    static void Postfix() { ... }
}
```

## Gotchas

- **Parameter names must match the original exactly.** Harmony binds by name,
  not position — a typo means your parameter is silently never populated (you
  get `default`), not a compile error. When in doubt, decompile the target
  (`decompile_dll`) and copy the signature.
- **`___field` needs the field's real name**, which decompilers sometimes
  mangle for backing fields (`<Prop>k__BackingField`). Verify against the
  decompiled source.
- An overloaded method patched without the `new[] { types }` disambiguator
  throws `AmbiguousMatchException` at patch time — the error fires during the
  static constructor, so the whole mod fails to load. Always disambiguate
  overloads.
- `[HarmonyPatch]` with a `TargetMethod()` and `[HarmonyPatch(typeof(...))]`
  are mutually exclusive styles — pick one per class.
