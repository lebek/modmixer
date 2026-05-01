---
title: reading logs
description: How to find and interpret RimWorld logs when a mod misbehaves.
---

# reading logs

When a mod breaks RimWorld, the first thing to check is `Player.log`. modmixer
can read it for you and explain what's going wrong.

## where logs live

On macOS:

```
~/Library/Logs/Ludeon Studios/RimWorld by Ludeon Studios/Player.log
```

On Windows:

```
%APPDATA%\..\LocalLow\Ludeon Studios\RimWorld by Ludeon Studios\Player.log
```

modmixer probes both paths automatically — you don't need to configure
anything.

## using the in-app diagnostic agent

In the modmixer UI, hit **diagnose** in the header. The agent reads your
current `Player.log`, finds the most recent error stack, and explains what
broke and how to fix it.

It can also disable the suspect mod for you and relaunch RimWorld.
