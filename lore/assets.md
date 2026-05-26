## XML defs and the cs-assets manifest are the asset truth

Modmixer discovers asset slots from two places:

1. **XML defs** — every `<texPath>` / `<graphicData><texPath>` / `<uiIconPath>` / `<clipPath>` / `<wornGraphicPath>` in `<mod>/Defs/**/*.xml` becomes a slot. The tag IS the source of truth; you don't declare these anywhere else.
2. **C# asset manifest** — `<mod>/.modmixer/cs-assets.json`. Shape:
   ```json
   {
     "textures": ["UI/Buttons/Settings", "Things/Item/Weapon/UnaaqGlow"],
     "audio": ["Combat/Whoosh"]
   }
   ```
   Every path you list here becomes a slot. Every `ContentFinder<Texture2D>.Get(...)` or `ContentFinder<AudioClip>.Get(...)` you write in C# code MUST have its path declared in this manifest, regardless of whether you pass a literal, a const, or anything else.

There is no third mechanism. No code-comment annotations, no convention-based discovery — if the path isn't in an XML tag or this JSON file, modmixer doesn't know it exists, and the stub system won't write a placeholder for it. Runtime will then error with "Could not load Texture2D at …".

## Why C# uses a manifest instead of being scanned

ContentFinder calls in idiomatic RimWorld code carry constants, not literals:

```csharp
private const string IconPath = "UI/Buttons/Settings";
public static readonly Texture2D Icon = ContentFinder<Texture2D>.Get(IconPath);
```

That's fine — write your code however you like. The manifest is what modmixer reads. Inlining literals at call sites isn't required.

Modmixer does run a sanity check: it grep-scans your `.cs` files for `ContentFinder<…>.Get("literal")` calls and emits drift warnings on the scan if:

- a literal appears in code but isn't declared in the manifest (you forgot to add it), OR
- a manifest entry doesn't appear as a literal anywhere (you removed the call but left the manifest entry, or the path is computed at runtime and the warning is a false positive — read and ignore).

Drift warnings come back in the asset scan's `warnings` field. Read them when you change C# asset code and reconcile the manifest.

## Vanilla paths are valid — write them, don't stub them

RimWorld's asset lookup is global across Core + DLC. Pointing `<texPath>Things/Item/Apparel/Shirt_Plain</texPath>` at the vanilla `Shirt_Plain` art is supported and idiomatic for reskin-style mods: the def keeps stats/labels custom while the art stays vanilla.

Modmixer detects vanilla paths by scanning `Data/<pack>/Defs/**/*.xml` for matching references. The actual PNG/OGG is bundled inside Unity asset archives so there's no preview — but the asset browser shows "uses vanilla art" on the card, and the stub system skips writing a magenta placeholder (which would otherwise shadow the bundled vanilla file at runtime).

When authoring a def that should reuse vanilla art, **just write the vanilla path**. Don't create a new texture path under the mod's namespace and don't `render_svg_to_png` a placeholder for it.

## Pick descriptive path stems

The Assets browser uses the def's `<label>` (XML) or the manifest entry's path tail (C#) as the slot title. Prefer descriptive paths so the title reads well:

- ✅ `UI/Settings/MainButton` → "MainButton"
- ❌ `UI/Icon` → "Icon" (useless, collides with everything)

Namespace your stems under your packageId tail so paths don't collide with vanilla or other mods.

## Placeholder .ogg files must be valid Vorbis streams, not empty stubs

Empty/truncated `.ogg` files produce `FMOD error: Unsupported file or audio format.` at game start. Modmixer's stub system already generates a valid silent Vorbis stream for asset paths the user hasn't filled in — manual stubs (e.g. testing with a hand-written empty file) need the same treatment. Generate with `ffmpeg -f lavfi -i anullsrc=r=22050:cl=mono -t 0.5 -c:a libvorbis out.ogg`.

*Why it's tricky:* "silent placeholder" ≠ "valid empty Vorbis stream". FMOD parses the header at load and rejects truncated files; the error noise then pollutes every test session and obscures real errors.

## Placeholders are auto-stubbed at sync — asset-load errors are SUSPICIOUS, not expected

`sync_to_game` runs the asset scanner, which writes a magenta-checker PNG or a valid silent OGG at every referenced asset path the user hasn't filled in AND that doesn't resolve to a vanilla file. The mod loads cleanly even with incomplete assets, and the test-in-game flow works on a half-finished mod.

Two consequences:

1. **Don't tell the user "the mod won't load until you add textures"** — it will load, with placeholders. Encourage them to test the behavior end-to-end and treat real-asset work as a separate, unblocking step.
2. **"Could not load texture/AudioClip/asset" errors at runtime are SUSPICIOUS, not expected.** The stub + vanilla-fallback system should have prevented them. Likely root causes, in order:
   - The path is loaded from C# but not declared in `.modmixer/cs-assets.json`. Read the scan's `warnings` — drift-check usually catches this exact case.
   - The path in a def doesn't match what the scanner extracts — backslashes, leading slash, .png/.ogg extension included in the def, casing on case-sensitive filesystems. Open the def and check.
   - The def lives somewhere the scanner doesn't read (not under `Defs/`, or in a Patch). The scanner only reads `Defs/**/*.xml`. If the path comes from a `PatchOperation`, the stub system can't see it — the user has to drop the asset in by hand, or you can move the def out of the patch.
   - The mod isn't actually synced (`sync_to_game` was skipped or failed) and RimWorld is loading a different copy.
   - The user manually removed `.modmixer/stubs.json` or a placeholder file between sync and launch.

Re-running `sync_to_game` often resolves cases 4/5. For cases 1/2, edit the manifest or def. For case 3, explain that the asset has to be dropped in by hand because it's referenced from a Patch.

*Why it's tricky:* without this prior, an asset-load error reads as "user just hasn't added their textures yet, ignore" — and the agent moves on without diagnosing the real bug. The stub + vanilla-fallback system means the error is real and worth investigating.
