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

## Route every user-facing string through the translation system — ship English Keyed XML; DefInjected covers def labels

Don't hardcode player-visible English. Two channels:
- **Def text** (`<label>`, `<description>`, def report strings): localized via `Languages/<Lang>/DefInjected/<DefType>/<DefName>.xml`, generated from your defs by translators — you do NOT hand-write English DefInjected; just author normal def XML.
- **Code strings** (`Command`/gizmo `defaultLabel`+`defaultDesc`, `Messages.Message`, letters, inspect strings, settings labels): add `<KeyName>Text</KeyName>` to `Languages/English/Keyed/<Mod>.xml` and reference it with `"KeyName".Translate()` (`.Translate(a, b)` fills `{0}`/`{1}` placeholders). Ship the English Keyed file so the keys resolve and other-language translators get a complete template.

*Why it's tricky:* this is the flip side of the diacritics bug above — call `.Translate()` on a key you forgot to add to the Keyed XML and RimWorld renders the raw key with combining diacritics, so add the key the moment you write the call. And hardcoded literals aren't a runtime error, so it's easy to ship an un-translatable mod without noticing — reviewers and translators will.
