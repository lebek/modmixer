# ModMixer Bridge (NeoForge 1.21.1)

A companion **bridge mod** for the [ModMixer](https://modmixer.app) desktop app.
ModMixer's AI agent builds Minecraft mods; at test time it launches the modded
client via Gradle `runClient` with this bridge loaded alongside the user's mod.

The bridge captures errors and mod-loading failures **inside the running game**
and streams them as structured, newline-delimited JSON over a localhost TCP
socket back to ModMixer — far more reliable than scraping the rotating
`latest.log` / `debug.log`. It is the Minecraft counterpart of ModMixer's
RimWorld bridge and speaks the **same wire protocol** (see
`src/agent/monitor/protocol.ts` in the ModMixer repo).

It does **not** modify gameplay. It only observes.

---

## What it does

On the mod constructor (NeoForge 1.21.1 / NeoForge 21.1.x / Java 21):

1. **Reporter thread.** Spawns a single daemon thread owning a
   `java.net.Socket` to `127.0.0.1:<port>`, fed by a bounded
   `LinkedBlockingQueue`. Producers never block (drop-on-full). Reconnect with
   exponential backoff (500 ms → 5000 ms), so it doesn't matter whether ModMixer
   is listening before or after the game starts. On every (re)connect it sends
   `bridge_hello`.

2. **Log4j2 capture.** Attaches a custom `AbstractAppender` to the **root**
   logger at `WARN`. Minecraft and essentially every mod log through Log4j2, so
   this sees the whole WARN/ERROR/FATAL stream — including the stack traces
   Minecraft logs just before it dies.

3. **Dedup.** A `ConcurrentHashMap` keyed by a stable fingerprint hash (FNV-1a
   seed + `h*31 ^ c` mix, identical algorithm to the RimWorld bridge's
   `ErrorsChannel`). The fingerprint is built from
   `level + exceptionClass + normalizedMessage + topN(normalizedStackFrames)`,
   where normalization strips numbers / coordinates / hex hashes so "same bug,
   different victim entity" collapses into one bucket. Exactly **one**
   `error_event` is emitted per new fingerprint; recurrences only bump an
   internal counter (the ModMixer server owns re-prompt suppression, and
   `protocol.ts` has no recurrence/count field — see "Protocol gaps").

4. **Load-time failures.** On the client, subscribes to `ScreenEvent.Opening`.
   When NeoForge's `LoadingErrorScreen` opens, it reads the loader's canonical
   `List<ModLoadingIssue>` via `net.neoforged.fml.ModLoader.getLoadingIssues()`
   (the screen only keeps converted private records, so we go to the source) and
   emits each issue — severity, translation key + args, cause `Throwable`,
   affected mod — as an `error_event`. Reaching `TitleScreen` is the clean-run
   signal; `FMLLoadCompleteEvent` marks load completion.

5. **Watchdog / auto-exit.** A wall-clock watchdog. **Only** when
   `-Dmodmixer.testTimeoutMs` is set, whichever fires first — `TitleScreen`
   reached, `LoadingErrorScreen`, or the timeout — flushes the queue and calls
   `System.exit` (0 for a clean run, non-zero if any error-severity events were
   collected). Without that property the bridge is purely passive (interactive
   use never force-quits the game).

6. **Crash-safe fallback.** If `-Dmodmixer.reportFile` is set, every emitted
   line is also appended to that NDJSON file, and a JVM shutdown hook drains the
   queue to it — so a crash before the socket flushes still yields a report.

---

## System properties

All are passed by ModMixer as Gradle `-D` args to `runClient`; MDG forwards them
to the game JVM.

| Property                    | Default | Meaning                                                                 |
|-----------------------------|---------|-------------------------------------------------------------------------|
| `modmixer.port`             | `13371` | TCP port of ModMixer's monitor server (`BRIDGE_PORT` in protocol.ts).   |
| `modmixer.token`            | _unset_ | Optional opaque handshake token, echoed in `bridge_hello` if present.   |
| `modmixer.testTimeoutMs`    | _unset_ | If set, enables auto-exit mode (the watchdog). If absent, no auto-exit. |
| `modmixer.reportFile`       | _unset_ | Path to append NDJSON fallback records to, drained on shutdown.         |

---

## Wire protocol

Transport: the bridge connects **out** to a TCP server ModMixer runs on
`127.0.0.1:port` and writes **newline-delimited, UTF-8 JSON, one object per
line**. The server greets with `server_hello` (which the bridge consumes and
ignores). The bridge then sends `bridge_hello`, followed by `error_event`s.

### `bridge_hello` (sent once per (re)connect)

```json
{"type":"bridge_hello","protocol":1,"rimworldVersion":"1.21.1","gameVersion":"1.21.1","bridgeVersion":"0.1.0","startedAt":1718000000000}
```

> The TS `BridgeHello` type names the version field `rimworldVersion`, and the
> server reads only that field for the connection banner — so the bridge emits
> it (carrying the Minecraft version). It **also** emits a forward-looking
> `gameVersion` alias with the same value; the server ignores unknown fields, so
> this is safe. `startedAt` is ms-since-epoch and is how the server distinguishes
> a real relaunch (new run) from a transient TCP reconnect (same run).

### `error_event` (one per new fingerprint)

```json
{"type":"error_event","severity":"error","firstLine":"java.lang.NullPointerException: ...","text":"[Render thread] net.minecraft...: ...\n\tat ...","attributedMods":["examplemod"],"hash":"a1b2c3d4e5f6","at":1718000001234}
```

Field-for-field it matches the TS `ErrorEvent`:
`type`, `severity` (`"message" | "warning" | "error"`), `firstLine` (≤ 240
chars), `text` (full message + stack, truncated to 4096 chars), `attributedMods`
(string array; `"Minecraft"` for vanilla, `"Unknown"` if no stack), `hash`
(lowercase hex), `at` (ms-since-epoch).

---

## Protocol gaps (intentional)

- **No `perf` / `mods_snapshot`.** `protocol.ts` defines `PerfTick` and
  `ModsSnapshot`, but those are RimWorld/Harmony-specific (TPS, Harmony patch
  graph, destructive prefixes). There is no faithful Minecraft analogue for the
  beta, so the bridge does not emit them. The server treats their absence
  gracefully (it just never updates those panels). They are candidates for a
  future Minecraft-specific perf/mixin channel.
- **No recurrence/count updates.** `ErrorEvent` has no count or update field, so
  the bridge emits only on first sight of a fingerprint and keeps the count
  internally (used only for the watchdog exit code). The server already
  increments its own per-bucket count on each re-sighting — but since we don't
  re-emit, that path is exercised only across reconnects, exactly like the
  RimWorld bridge.
- **No "clean run" / "load complete" message.** `TitleScreen` and
  `FMLLoadCompleteEvent` are used as internal milestones (watchdog success, log
  line) but have no wire message in the current protocol.

---

## Building

This directory is a standalone Gradle project using
[ModDevGradle](https://github.com/neoforged/ModDevGradle) (`net.neoforged.moddev`
~2.0.x). It targets the toolchain pinned in `gradle.properties`, which mirrors
`src/agent/minecraft/versions.ts` in the ModMixer app:

- Minecraft `1.21.1`
- NeoForge `21.1.234`
- Parchment `1.21.1` / `2024.11.17`
- Java `21`

```bash
./gradlew build        # -> build/libs/modmixerbridge-0.1.0.jar
./gradlew runClient    # standalone smoke test (uses your local JDK 21)
```

### The Gradle wrapper is **not** committed here

The binary `gradle/wrapper/gradle-wrapper.jar` (and `gradlew` / `gradlew.bat` /
`gradle-wrapper.properties`) are intentionally omitted. **ModMixer supplies the
wrapper from its vendored NeoForge MDK scaffold** when it integrates this mod
into a project. To build standalone during development, generate one with a
locally installed Gradle:

```bash
gradle wrapper --gradle-version 8.10
```

(8.8+ is fine for ModDevGradle 2.0.x on Java 21.)

### Integration into the scaffold

In production ModMixer does not ship this as a separate jar that the user has to
manage. It either (a) drops the built `modmixerbridge-*.jar` onto the user mod
project's `runClient` classpath, or (b) merges these `src/main` sources +
`neoforge.mods.toml` into the scaffolded mod project so both mods load from one
run. Either way the final wrapper + scaffold wiring (and the `-Dmodmixer.*` args
on the `runClient` invocation) are owned by ModMixer, not this directory.

---

## Layout

```
build.gradle                                  ModDevGradle build
settings.gradle                               plugin + NeoForge maven
gradle.properties                             pinned toolchain + mod metadata
src/main/resources/META-INF/neoforge.mods.toml  mod manifest (javafml, deps)
src/main/java/com/modmixer/bridge/
  ModMixerBridge.java     @Mod entry: props, wiring, watchdog, exit
  ClientHooks.java        client-only screen events (load failure / clean run)
  BridgeClient.java       daemon reporter: socket, queue, backoff, hello, NDJSON
  LogAppender.java        Log4j2 root appender @WARN -> error_event + dedup
  ErrorFingerprint.java   FNV+mix hash (matches RimWorld ErrorsChannel)
  Attribution.java        stack package -> mod id
  LoadingIssues.java      typed reader for net.neoforged.fml.ModLoadingIssue
  Json.java               tiny JSON writer (matches RimWorld Json.cs escaping)
```

## API verification notes

The load-bearing NeoForge APIs were confirmed against
[neoforged/FancyModLoader](https://github.com/neoforged/FancyModLoader):

- **`@Mod` constructor injection.** The mod class must have exactly one public
  constructor; allowed injected types are `IEventBus` (mod event bus),
  `ModContainer`/`FMLModContainer`, and `Dist`. We use `(IEventBus)`. ✔ verified.
- **`ModLoadingIssue`** (`net.neoforged.fml`) is a record:
  `(Severity severity, String translationKey, List<Object> translationArgs,
  Throwable cause, Path affectedPath, IModFile affectedModFile,
  IModInfo affectedMod)`, `enum Severity { WARNING, ERROR }`. ✔ verified.
- **`ModLoader.getLoadingIssues()`** returns `List<ModLoadingIssue>`
  (`@ApiStatus.Internal` but `public static`). ✔ verified — used instead of
  scraping the `LoadingErrorScreen`'s private `FormattedIssue` lists.
- **Attribution chain.** `ModList.get().getMods()` → `List<IModInfo>`;
  `IModInfo.getOwningFile().getFile().getScanResult()` → `ModFileScanData`;
  `getClasses()` → `Set<ClassData>`; `ClassData.clazz().getClassName()` (ASM
  `Type`). ✔ verified.

One signature remains marked `// VERIFY against 21.1.x sources` and is guarded
so a drift degrades gracefully: `FMLLoader.versionInfo().mcVersion()` (the
Minecraft version string for `bridge_hello`). On newer FancyModLoader this moved
to `FMLLoader.getCurrent().versionInfo.mcVersion()`; either way the call is
wrapped and falls back to the hard-pinned `"1.21.1"` (correct for this bridge),
so the hello is always right. The `ScreenEvent.Opening#getScreen()` accessor and
the Log4j2 `LoggerContext` cast are likewise guarded. None are on the critical
error-capture path (the Log4j2 appender is the primary channel).
