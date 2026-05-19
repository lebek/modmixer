# Harmony transpilers (IL rewriting)

> **Reference** — Harmony 2.x, stable. Read `prefix-postfix.md` first — a
> transpiler is the last resort, not the first.

## When a transpiler is the only option

A transpiler rewrites the original method's CIL instruction stream. Use it
**only** when prefix/postfix genuinely can't do the job — typically:

- changing logic *in the middle* of a method (not at entry/exit),
- altering a value passed to an inner call you can't otherwise reach,
- removing or replacing a specific instruction.

If prefix or postfix can express the change, use them. A transpiler is the
most fragile patch type: it binds to the exact IL the compiler emitted, so a
RimWorld point release that recompiles the method differently can break it
silently (no exception — just wrong behavior or a skipped edit).

## Shape

A transpiler takes and returns `IEnumerable<CodeInstruction>`. Use
`CodeMatcher` to locate an instruction pattern and edit around it rather than
hand-walking the list:

```csharp
using System.Collections.Generic;
using System.Reflection;
using HarmonyLib;

public static IEnumerable<CodeInstruction> Transpiler(
    IEnumerable<CodeInstruction> instructions)
{
    var target = AccessTools.Method(typeof(SomeClass), "SomeMethod");
    return new CodeMatcher(instructions)
        .MatchStartForward(new CodeMatch(OpCodes.Call, target))
        .ThrowIfInvalid("could not find SomeClass.SomeMethod call")
        .Advance(1)
        .Insert(
            new CodeInstruction(OpCodes.Ldarg_0),
            new CodeInstruction(OpCodes.Call,
                AccessTools.Method(typeof(MyPatch), nameof(Adjust))))
        .InstructionEnumeration();
}
```

## Gotchas

- **Always `ThrowIfInvalid` (or check `IsValid`) after a match.** If the IL
  shifts and your pattern no longer matches, a silent transpiler edits nothing
  and the bug looks like "the patch didn't apply" with no error. A loud throw
  at startup is far easier to diagnose.
- **Match the fewest, most stable instructions.** Anchoring to a `Call` of a
  named method or a `ldstr` of a literal survives recompilation; anchoring to a
  run of `ldloc`/`stloc` does not — local-variable indices shuffle freely.
- Label and exception-block handling: when you insert/remove around an
  instruction that carries a branch label or block boundary, move the label
  with `CodeMatcher` helpers — a dropped label produces an `InvalidProgramException`
  at JIT time.
- Test the patched method in-game (`run_test_cycle`) — a transpiler that
  compiles fine can still produce invalid IL that only fails when the method
  is first JITed.
- Prefer pairing a transpiler with a tiny static helper (as above): do the
  *minimum* in IL — redirect to a call — and write the real logic in normal
  C# where it's readable and version-robust.
