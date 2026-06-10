# Modmixer Live

Experimental in-game live-modding companion for the Modmixer desktop app.
Adds a chat window to a running RimWorld game (toggle lives in the
bottom-right play-settings strip) where prompts go to the Modmixer agent,
and executes what the agent sends back: hot-loaded assemblies, one-shot C#
actions, and def reloads. Connects out to the app on 127.0.0.1:13372 —
newline-delimited JSON, both directions.

This mod does nothing without the app. Modmixer installs it automatically
when launching a live session.

## Building

    dotnet build Source/ModMixerLive.csproj

RimWorld's managed assemblies must be resolvable; the default
`RimWorldManagedDir` points at the macOS Steam install (same as the bridge
mod). Override it elsewhere:

    dotnet build Source/ModMixerLive.csproj -p:RimWorldManagedDir=/path/to/RimWorld/Data/Managed

The build produces `Assemblies/` (ModMixerLive.dll plus 0Harmony.dll), which
is checked in so the app and packaged installer work out of the box (the app
refuses to install the mod when the assembly is missing). Rebuild and commit
the result whenever the C# source changes.
