## Placeholder .ogg files must be valid Vorbis streams, not empty stubs

Empty/truncated `.ogg` files produce `FMOD error: Unsupported file or audio format.` at game start. If you ship the mod with placeholder audio, generate a valid silent Vorbis stream (e.g. `ffmpeg -f lavfi -i anullsrc=r=22050:cl=mono -t 0.5 -c:a libvorbis out.ogg`) rather than a zero-byte file.

*Why it's tricky:* "silent placeholder" ≠ "valid empty Vorbis stream". FMOD parses the header at load and rejects truncated files; the error noise then pollutes every test session and obscures real errors. Modmixer's stub system already does this for asset paths the user hasn't filled in — manual stubs need the same treatment.

## Asset reference annotations: comment above every texPath / clipPath

Whenever you write or edit a def XML element pointing to an external asset (`<texPath>`, `<graphicData><texPath>`, `<uiIconPath>`, `<clipPath>`), put an XML comment on the line directly above describing what the asset is and when it triggers in-game.

```xml
<!-- Soft thumping ambient loop, plays during the colony siege event. Mono ogg, 5–15s, loopable. -->
<clipPath>MyMod/SiegeAmbient</clipPath>
```

*Why it's tricky:* the modmixer Assets browser pulls these comments out and shows them to the user so they know what file to provide. Without the comment, the user has to reverse-engineer the def to know what asset to make.
