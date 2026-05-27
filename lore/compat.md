## Wrap Win32 P/Invokes in same-name shims so non-Windows platforms get graceful no-op instead of DllNotFoundException

P/Invokes to `user32.dll` (`keybd_event`, `mouse_event`, `SetCursorPos`, `GetCursorPos`) throw `DllNotFoundException` on Linux/macOS (Steam Deck Proton, future Linux native build). The DLL doesn't resolve until the method is actually CALLED — extern declarations alone are fine to compile and load on any platform — so the smallest-touch fix is to wrap each P/Invoke behind a same-name method that short-circuits before the extern fires.

Recipe (per P/Invoke):
```csharp
[DllImport("user32.dll", EntryPoint = "keybd_event")]
static extern void _native_keybd_event(byte vk, byte scan, uint flags, int extra);
static void keybd_event(byte vk, byte scan, uint flags, int extra)
{
    if (Application.platform != RuntimePlatform.WindowsPlayer
        && Application.platform != RuntimePlatform.WindowsEditor) return;
    _native_keybd_event(vk, scan, flags, extra);
}
```

The `EntryPoint = "..."` attribute lets the underscored-name extern still bind to the original symbol. Every caller in your codebase keeps using `keybd_event(...)` unchanged — no callsite churn.

Combine with a one-time `Log.Warning` ("Running on non-Windows; face-button actions that rely on synthetic Win32 keystrokes will no-op — map them through Steam Input instead") so players understand the partial-support state.

*Why it's tricky:* the obvious-looking solution is to `[Conditional("UNITY_STANDALONE_WIN")]` the calls or wrap each callsite in `if (Application.platform == ...)`, but conditionals don't work for P/Invoke and per-callsite gating is dozens of edits. The same-name shim is one edit per P/Invoke and zero edits per call.

## Don't auto-disable opt-in features on Harmony-patch conflict — log a heads-up and let the user toggle

When an opt-in mod feature replaces a vanilla UI method via Harmony (e.g. Tier-3 menus that prefix `DoWindowContents` and return false), the obvious safety net is "scan `Harmony.GetPatchInfo` for foreign patches on the same method, and auto-disable my feature if any are found". This is too cautious. Most foreign Harmony patches DON'T actually break visible compositing — they may capture rects, draw highlights, fire telemetry, etc. Auto-disabling silently hides the feature from a large fraction of users who'd otherwise be fine.

Better pattern: keep the conflict scan, but make it **diagnostic only**.

- `LockedByModConflict` is a public property kept for the settings UI to read.
- `IsActive` checks ONLY the user's settings flag, NOT the lock.
- `DetectModConflict` runs at startup, sets `LockedByModConflict`, and emits ONE `Log.Message` — "Heads-up: another mod has patched X. <Feature> is still on; turn it off in mod settings if you see glitches."
- Settings UI always shows the toggle, and when `LockedByModConflict` is true, draw a yellow `⚠` heads-up line under the checkbox so the user knows there's a potential issue.

The user keeps control: their toggle does what it says. If the other mod's patch actually breaks things, they see it visually and flip the toggle off themselves.

*Why it's tricky:* the auto-disable is *technically* the safer default, but in practice most Harmony patches coexist fine, and "feature silently doesn't work and there's an obscure log message explaining why" is the worst possible UX — the user just thinks the mod is broken. Trust the user to flip a toggle if they see actual problems.
