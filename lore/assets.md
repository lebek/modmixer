## The mod's defs and C# code ARE the asset manifest

Modmixer discovers every asset the mod needs by scanning `<mod>/Defs/**/*.xml` for `<texPath>` / `<graphicData><texPath>` / `<uiIconPath>` / `<clipPath>` / `<wornGraphicPath>`, and `<mod>/**/*.cs` for `ContentFinder<Texture2D>.Get("…")` / `ContentFinder<AudioClip>.Get("…")`. Every match becomes a slot in the Assets browser the user can drop a file into.

That scan is the **only** source of truth. There is no sidecar JSON the agent needs to write or update. There is no annotation comment requirement. Add a `<texPath>` and it appears in the UI; remove it and the slot disappears.

*Why it's tricky:* an earlier version of modmixer asked the agent to write XML comments above every asset path describing what the asset was. That requirement is gone — the comments were just headlines for the old UI and the new UI shows the path itself. If you still see old `<!-- … -->` comments above `<texPath>` tags in a mod, leave them alone, but don't add new ones.

## Vanilla paths are valid — write them, don't stub them

RimWorld's asset lookup is global across Core + DLC packs. Pointing `<texPath>Things/Item/Apparel/Shirt_Plain</texPath>` at the vanilla `Shirt_Plain.png` is supported and idiomatic for reskin-style mods: the def keeps stats/labels custom while the art stays the base-game sprite.

The Assets browser shows a vanilla preview for paths that resolve into Core/DLC, so the user can see what's already there. If they want their own art they drop a file in; if they don't, the slot stays as-is and RimWorld loads vanilla at runtime.

This means: when you author a def that should reuse vanilla art, **just write the vanilla path**. Don't create a new texture path under the mod's namespace and don't `render_svg_to_png` a placeholder for it. The placeholder would shadow vanilla at runtime.

## Pick descriptive path stems

The Assets browser titles each slot from the trailing segment of the path. `UI/Settings/MainButton` becomes "MainButton" — useful. `UI/Icon` becomes "Icon" — useless. When you choose a stem in a def or C# call, pick something the user will recognise without having to open the def.

For C#: prefer `ContentFinder<Texture2D>.Get("MyMod/UI/SettingsToggle")` over `ContentFinder<Texture2D>.Get("Icon")`. Namespace under your packageId tail so paths don't collide with vanilla or other mods.

## Placeholder .ogg files must be valid Vorbis streams, not empty stubs

Empty/truncated `.ogg` files produce `FMOD error: Unsupported file or audio format.` at game start. Modmixer's stub system already generates a valid silent Vorbis stream for asset paths the user hasn't filled in — manual stubs (e.g. testing with a hand-written empty file) need the same treatment. Generate with `ffmpeg -f lavfi -i anullsrc=r=22050:cl=mono -t 0.5 -c:a libvorbis out.ogg`.

*Why it's tricky:* "silent placeholder" ≠ "valid empty Vorbis stream". FMOD parses the header at load and rejects truncated files; the error noise then pollutes every test session and obscures real errors.

## Placeholders are auto-stubbed at sync — asset-load errors are SUSPICIOUS, not expected

`sync_to_game` runs the asset scanner, which writes a magenta-checker PNG or a valid silent OGG at every referenced asset path the user hasn't filled in AND that doesn't resolve to a vanilla file. The mod loads cleanly even with incomplete assets, and the test-in-game flow works on a half-finished mod.

Two consequences:

1. **Don't tell the user "the mod won't load until you add textures"** — it will load, with placeholders. Encourage them to test the behavior end-to-end and treat real-asset work as a separate, unblocking step.
2. **"Could not load texture/AudioClip/asset" errors at runtime are SUSPICIOUS, not expected.** The stub + vanilla-fallback system should have prevented them. Likely root causes, in order:
   - The path in the def doesn't match what the scanner extracts — backslashes, leading slash, .png/.ogg extension included in the def, casing on case-sensitive filesystems. Open the def and check.
   - The def lives somewhere the scanner doesn't read (not under `Defs/`, or in a Patch). The scanner only reads `Defs/**/*.xml`. If the path comes from a `PatchOperation`, the stub system can't see it — the user has to drop the asset in by hand.
   - The mod isn't actually synced (`sync_to_game` was skipped or failed) and RimWorld is loading a different copy.
   - The user manually removed `.modmixer/stubs.json` or a placeholder file between sync and launch.

Re-running `sync_to_game` often resolves cases 3/4. For case 1, edit the def. For case 2, explain that the asset has to be dropped in by hand because it's referenced from a Patch.

*Why it's tricky:* without this prior, an asset-load error reads as "user just hasn't added their textures yet, ignore" — and the agent moves on without diagnosing the real path-extraction bug. The stub + vanilla-fallback system means the error is real and worth investigating.
