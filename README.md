<div align="center">

[<img alt="modmixer" src="assets/logo.svg" width="360">](https://modmixer.com)

[![Discord](https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/54QhJeNvFy) [![Build status](https://img.shields.io/github/actions/workflow/status/lebek/modmixer/ci.yml?style=flat-square&branch=main)](https://github.com/lebek/modmixer/actions/workflows/ci.yml)

[modmixer.com](https://modmixer.com)

</div>

---

Build RimWorld mods without writing code.

Modmixer is a desktop app that lets you describe a mod in plain English and
have an AI agent build it for you. You chat, it edits the XML and C# files
in your Mods folder, manages your art and audio assets, launches the game
to test, watches the logs for errors, and helps you publish to the Steam
Workshop when you're happy.

Mods aren't just code. Modmixer also helps you import sprites, textures,
and audio, and lays them out inside your mod folder the way RimWorld
expects.

It's also useful if you do write code — the agent does the boring parts
(scaffolding, def-graph lookups, log triage) so you can focus on the
interesting design decisions.

## Status

Early. Expect rough edges. Issues and PRs welcome.

## Install

Pre-built releases (Windows, macOS, Linux) live at
<https://github.com/lebek/modmixer/releases>.

## Build from source

Requires Node.js 22+ and npm. (The test runner relies on Node's built-in
glob support in `--test`, added in 22.)

```sh
git clone --recurse-submodules https://github.com/lebek/modmixer.git
cd modmixer
npm ci
npm start
```

The `vendor/pi-mono` submodule provides the agent runtime
([badlogic/pi-mono](https://github.com/badlogic/pi-mono)). If you cloned
without `--recurse-submodules`, run `git submodule update --init` first.

Other useful scripts:

```sh
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm test            # tsx test runner
npm run package     # build an unsigned local app bundle
npm run make        # build platform installers (.dmg, .exe, .deb, ...)
```

### ilspycmd (dev only)

The agent's C# index decompiles RimWorld's assemblies on first run so
tools like `search_source` and `read_csharp_symbol` can answer Verse-API
questions. The packaged release bundles a vendored ilspycmd binary, so
**end users running a pre-built installer don't need to do anything**.

When running from source (`npm start`), you need ilspycmd on PATH.
Install it once per machine:

1. Install the .NET 8 SDK
   ([download](https://dotnet.microsoft.com/download), or
   `winget install Microsoft.DotNet.SDK.8` on Windows,
   `brew install --cask dotnet-sdk` on macOS).
2. Install ilspycmd as a global dotnet tool:

   ```sh
   dotnet tool install -g ilspycmd --version 9.1.0.7988
   ```

   Pin to `9.1.0.7988` — the current `10.x` packages on nuget ship a
   broken `DotnetToolSettings.xml` and won't install.

If ilspycmd isn't found at startup, the index modal surfaces an error
and the agent's C# tools won't work; the rest of the app (def search,
scaffolding without C#, log triage) still functions.

## Architecture

- `src/main.ts` — Electron main process, IPC, window lifecycle.
- `src/agent/` — agent host, tool implementations, Workshop integration,
  Player.log watcher, mod scaffolding, settings, telemetry.
- `src/components/` — React renderer (chat panel, build view, def graph,
  monitor, settings).
- `vendor/modmixer-bridge/` — small RimWorld mod (C#, HarmonyLib) that
  streams diagnostics to the app over localhost TCP. Built separately and
  shipped as a Workshop mod.

## Telemetry & privacy

Modmixer can send a small amount of anonymous usage data and crash reports.
This section documents exactly what.

**You can disable both at any time** in Settings → "Help improve modmixer".
Toggling takes effect immediately, no relaunch required.

### What is sent

- **Product analytics** (PostHog), when opted in. Three events, no
  payloads: `app_started`, `mod_created`, `mod_published`. Your app
  version and OS are attached once as profile properties — not on every
  event.
- **Crash reports** (Sentry), when a build-time DSN is configured. Stack
  traces, breadcrumbs, and error messages are passed through a scrubber
  that replaces home directory paths (`/Users/<name>`, `C:\Users\<name>`,
  `/home/<name>`) with `/<user>` so your Steam id and username don't
  leak. Scrubbing is best-effort — see "Caveats" below.

### What is *not* sent

- Prompt text, model output, full file contents, or any user-authored
  code.
- Email, account info, OAuth tokens.
- IP address is not stored on the event (`sendDefaultPii: false` plus an
  explicit drop). Sentry's servers necessarily see the source IP of the
  HTTPS request itself — that's standard Sentry behaviour, not data
  Modmixer attaches.
- Per-event app version and OS — those are attached once as profile
  properties on PostHog, not on every event.

### Caveats

Crash reports are necessarily messy. Scrubbing covers the common
PII-shaped patterns but can't guarantee zero leakage:

- A mod folder name embedded in a thrown error (e.g. `failed to parse
  Defs/MyMod/Things.xml`) will appear in Sentry. The folder name is
  yours, not the user's, and is usually already public on Workshop.
- A bug in third-party code may put unexpected strings in stack frames
  or breadcrumb payloads that the scrubber doesn't recognize.

If this is a concern, leave crash reports off in Settings.

### Self-built / forks

If you build Modmixer yourself without setting `SENTRY_DSN` and `POSTHOG_KEY`
at build time, both clients short-circuit and no network calls are made.

Source of truth: [`src/agent/telemetry.ts`](src/agent/telemetry.ts) and
[`src/agent/sentry.ts`](src/agent/sentry.ts).

## OAuth tokens

Modmixer can sign you in to AI providers (Anthropic, OpenAI, Google) via
OAuth. Tokens are stored encrypted on disk using Electron `safeStorage`,
which is backed by:

- macOS — Keychain
- Windows — DPAPI
- Linux — libsecret (kwallet / gnome-keyring)

See [`src/agent/security/secure-auth-storage.ts`](src/agent/security/secure-auth-storage.ts).

## License

MIT. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE) for third-party
attribution.
