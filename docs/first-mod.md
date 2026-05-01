---
title: your first mod
description: Go from a one-line idea to a loaded mod in RimWorld.
---

# your first mod

1. Click **create** in the modmixer header.
2. Type a one-line idea — e.g. _"a hat that boosts social by 5"_.
3. modmixer generates the sprite, the `ThingDef`, and a buildable folder.
4. Hit **install**. The mod lands in your local Mods directory.
5. Launch RimWorld, enable the mod, start a colony.

## what just happened

modmixer wrote a `.csproj` targeting `net472` (the framework RimWorld
expects), generated XML defs, and rendered a sprite at the correct
resolution for the in-game item.
