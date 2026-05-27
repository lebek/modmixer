## Strings rendered with diacritics in-game = .Translate() called on a missing key

If a string shows up in-game with weird diacritic marks layered onto every letter (e.g. `CòpýPàṣṭèTìṁèṭàb̀l̀è` instead of `CopyPasteTimetable`), that's vanilla's "missing translation key" indicator firing — `"SomeKey".Translate()` was called but no translation entry exists, so vanilla returns the raw key string with combining diacritical marks layered on top to make the bug visually obvious.

Common cause: using `.Translate()` on an internal identifier (a `defName`, a column name, an arbitrary string) that you assumed had a translation entry but doesn't. Fix: just use the plain English text as a literal instead. Don't call `.Translate()` unless you've confirmed the key exists in `Languages/English/Keyed/*.xml`.

Example bug pattern:
```csharp
// Wrong — "CopyPasteTimetable" is a defName, not a translation key.
// Renders as "CòpýPàṣṭèTìṁèṭàb̀l̀è".
return "CopyPasteTimetable".Translate() + " - " + "CommandCopyZoneSettingsLabel".Translate();

// Right — plain English literals.
return "Copy / Paste timetable - A: Copy, X: Paste";
```

*Why it's tricky:* the diacritics look like a Unicode encoding bug, a font issue, or a "weird character corruption" — not an obvious "missing translation". You'll waste time checking string encoding before realising the call is just `.Translate()` on a non-existent key. Strings that ARE valid translation keys live in `Languages/<Lang>/Keyed/*.xml` (or `DefInjected/`); anything else passed to `.Translate()` triggers the diacritics fallback.
