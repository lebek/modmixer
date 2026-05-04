## Placeholder .ogg files must be valid Vorbis streams, not empty stubs

Empty/truncated `.ogg` files produce `FMOD error: Unsupported file or audio format.` at game start. If you ship the mod with placeholder audio, generate a valid silent Vorbis stream (e.g. `ffmpeg -f lavfi -i anullsrc=r=22050:cl=mono -t 0.5 -c:a libvorbis out.ogg`) rather than a zero-byte file.

*Why it's tricky:* "silent placeholder" ≠ "valid empty Vorbis stream". FMOD parses the header at load and rejects truncated files; the error noise then pollutes every test session and obscures real errors. Modmixer's stub system already does this for asset paths the user hasn't filled in — manual stubs need the same treatment.

## Asset reference annotations: comment above every texPath / clipPath

Whenever you write or edit a def XML element pointing to an external asset (`<texPath>`, `<graphicData><texPath>`, `<uiIconPath>`, `<clipPath>`), put an XML comment on the line directly above describing what the asset is and when it triggers in-game.

```xml
<li>
  <!-- Soft thumping ambient loop, plays when an anomaly event is active in the colony. Mono ogg, 5–15s, loopable. -->
  <clipPath>STALKRIM/AnomalyAmbient</clipPath>
</li>
```

Rules for these comments:

- One sentence (max two). Describe the SOUND/SPRITE itself (what it depicts or sounds like) and the TRIGGER (when the player will see/hear it).
- For audio, mention duration ballpark and whether it should loop.
- For textures, mention typical dimensions (e.g. 64×64 PNG) and whether team-color tinting via `_m.png` is expected.
- Keep referencing the same path with the same comment across the file — don't re-describe per-grain duplicates.
- Editing an existing path? Update the adjacent comment too if the meaning changed.

*Why it's tricky:* the modmixer Assets browser pulls these comments out and shows them to the user so they know what file to provide. Without the comment, the user has to reverse-engineer the def to know what asset to make.

## Placeholders are auto-stubbed at sync — asset-load errors are SUSPICIOUS, not expected

`sync_to_game` runs the asset scanner, which writes a magenta-checker PNG or a valid silent OGG at every referenced asset path the user hasn't filled in. So the mod loads cleanly even with incomplete assets, and the test-in-game flow works on a half-finished mod.

Two consequences:

1. **Don't tell the user "the mod won't load until you add textures"** — it will load, with placeholders. Encourage them to test the behavior end-to-end and treat real-asset work as a separate, unblocking step.
2. **"Could not load texture/AudioClip/asset" errors at runtime are SUSPICIOUS, not expected.** The stub system should have prevented them. Likely root causes, in order:
   - The path in the def doesn't match what the scanner extracts — backslashes, leading slash, .png/.ogg extension included in the def, casing on case-sensitive filesystems. Open the def and check.
   - The def lives somewhere the scanner doesn't read (not under `Defs/`, or in a Patch). The scanner only reads `Defs/**/*.xml`. If the path comes from a `PatchOperation`, the stub system can't see it — the user has to drop the asset in by hand.
   - The mod isn't actually synced (`sync_to_game` was skipped or failed) and RimWorld is loading a different copy.
   - The user manually removed `.modmixer/stubs.json` or a placeholder file between sync and launch.

Re-running `sync_to_game` often resolves cases 3/4. For case 1, edit the def. For case 2, explain that the asset has to be dropped in by hand because it's referenced from a Patch.

*Why it's tricky:* without this prior, an asset-load error reads as "user just hasn't added their textures yet, ignore" — and the agent moves on without diagnosing the real path-extraction bug. The stub system means the error is real and worth investigating.
