# Modmixer Live — v1 Plan

Status: draft, June 2026. Experimental feature.

## What it is

One button in the app: **"Launch Live Session."** It creates a fresh session
mod, launches RimWorld into an isolated throwaway colony with the new
**Modmixer Live** in-game mod installed, and from then on the user plays the
game and talks to Modmixer through a small in-game chat window. Prompts are
fulfilled live — one-shot actions ("attack my colony with geese") execute in
seconds, persistent features ("show colonist mood above their heads") are
compiled and hot-loaded into the running game without a restart.

Toy framing is explicit: this is for fun, not for building polished Workshop
mods. It's allowed to break sometimes — the blast radius is a disposable test
colony. Everything still lands in a real workspace mod folder, so anything
good survives the session.

### Non-goals for v1

- Working inside the user's real colony / real save / real mod list. (The
  Live mod IS distributed via Steam Workshop — as the install channel and
  modmixer.com funnel — but app-launched sandboxed sessions remain the only
  way to use it.)
- Slash commands or a console idiom. (RimWorld has no native console; the
  chat window is the UI.)
- Showing tool calls, file diffs, or any agent internals in-game.
- C# detour hot-swapping of stateful classes (Cecil classifier + detour
  engine are v1.5).
- Multiple simultaneous live sessions.

## Two mods, not one

The existing bridge (`vendor/modmixer-bridge`) stays exactly as it is: a
passive telemetry tap (log hook, perf, patch graph) that gets silently
junction-linked into every test session. The live engine is, by design, a
localhost socket that accepts and executes compiled code — that capability
must not ride along invisibly in every test session.

**Modmixer Live** is a second mod in `vendor/modmixer-live/`, distributed
via Steam Workshop in packaged builds (the app links to the official item
and gates on its `<modVersion>`; see `src/agent/live/install.ts` and
`scripts/publish-live-mod.mjs`). Dev checkouts junction `vendor/` directly,
installed **only** for live sessions and removed on teardown. Both mods are
loaded during a live session: bridge for error telemetry, Live for chat +
commands. They share source files (TCP client, JSON) but connect
separately.

## Architecture

```
RimWorld (isolated session)                    Modmixer app
┌─────────────────────────────┐               ┌──────────────────────────────┐
│ ModmixerBridge (unchanged)  │──13371──────▶ │ MonitorServer (unchanged)    │
│   errors/perf/patch graph   │               │   error buckets → auto-prompt│
│                             │               │                              │
│ Modmixer Live (new)         │◀─13372──────▶ │ LiveServer (new)             │
│   chat window               │  user_prompt  │   routes to bound conversation│
│   LiveLoader (hot load)     │  agent_say    │   AgentSession (existing,    │
│   exec_csharp invoker       │  hot_load     │     live tool set)           │
│   LiveState (scribed store) │  exec_csharp  │   scratch + session builds   │
└─────────────────────────────┘  cmd_result   └──────────────────────────────┘
```

Source of truth is always the session mod's source in the workspace. Each
live iteration is a full reconciliation: rebuild the whole mod → fresh
versioned assembly → `UnpatchAll(sessionHarmonyId)` → load → `PatchAll` →
re-register defs. No patch residue across add/remove/change cycles; after
every iteration, live behavior == current source.

## The v1 simplification

We skip the assembly diff classifier and detour bookkeeping entirely by
constraining the code the agent generates (enforced via the live-mode system
prompt) to shapes the unpatch→repatch cycle fully covers:

1. All behavior = Harmony patches + static logic classes + defs. No custom
   `ThingComp` / `MapComponent` / `GameComponent` subclasses in session-mod
   code in v1.
2. All persistent state lives in **`LiveState`**, a generic keyed scribed
   store (per-game and per-thing) that ships inside the Live mod itself — a
   stable assembly that is never hot-swapped. Generated code never defines
   scribed types, so it never hits the Mono type-layout wall and never
   poisons a save with versioned-assembly type names.
3. Hot assemblies are compiled with inlining suppressed so future swaps
   always take effect.

This covers both flagship examples and nearly everything toy-tier. When a
request genuinely needs something outside these constraints, the agent says
so in the chat window and offers a relaunch.

## One-shot actions: `exec_csharp` (no primitives)

There is no fixed primitive vocabulary. The one-shot mechanism is arbitrary
C#: the agent writes a snippet, the app compiles it into a tiny scratch
assembly (separate pre-warmed csproj, NOT the session mod), and the Live mod
loads and invokes it.

Contract:

```csharp
public static class LiveAction {
    // Runs on the main thread, game paused. Full Verse/RimWorld API access.
    public static string Run() { ... return "what happened"; }
}
```

- Invoke is wrapped in try/catch; `cmd_result` carries either the returned
  string or the full exception + stack. The agent reads the exception, fixes
  the snippet, retries — same loop it already runs on compile errors.
- Delayed breakage (bad state that throws ticks later) arrives through the
  existing bridge error pipeline as an auto-prompt.
- **Spawn ledger:** the Live mod Harmony-hooks `GenSpawn.Spawn` only for the
  duration of a `Run()` invocation and records everything spawned,
  regardless of how the snippet spawned it. Plus a `Live.Track(thing)`
  helper for exotic cases. v1 only records the ledger (undo is v1.5), but
  recording from day one is cheap and reconstruction later is not.
- Snippet rules taught in the system prompt: don't block the main thread
  (kick long work to `LongEventHandler`), no threads touching game state,
  scratch assemblies never unload so never define scribed types in a
  one-shot — anything persistent goes through `LiveState` or the session mod.

Why app-side compile instead of in-game Roslyn/Mono eval: end-to-end latency
is dominated by the LLM turn, a warm incremental `dotnet build` is 1–2s, and
one toolchain means one error format the agent already knows. In-game eval
is a v2 latency optimization at best.

The verb split the agent decides per request:
- `game_action(code)` — do something now; leaves no source behind (ledger
  entry only). "Make that permanent" promotes the snippet into the session
  mod.
- `apply_live` — change the game's rules; edits session-mod source, goes
  through the reconciler, survives iteration and removal.

## Workstreams

### A. Protocol + LiveServer (TS, ~2–3 days)

- New `src/agent/monitor/live-protocol.ts` and `live-server.ts`. Separate
  server on **port 13372**, modeled on `MonitorServer`
  (`src/agent/monitor/server.ts`) — the existing monitor path is untouched
  and both connections coexist.
- Messages, game→app: `live_hello {protocol, liveVersion, gameStartedAt}`,
  `user_prompt {text}`, `cmd_result {id, ok, detail}`.
  App→game: `server_hello`, `server_reject {reason}` (version mismatch — the
  game UI renders "update Modmixer" instead of failing silently),
  `agent_status {text}`, `agent_say {text}`, `agent_busy {bool}`, and
  commands `hot_load {id, dllPath}`, `unpatch_all {id}`,
  `reload_defs {id}`, `exec_csharp {id, dllPath}`.
- Id-correlated request/response helper with timeout (command → promise of
  `cmd_result`).

### B. Modmixer Live mod (C#, new `vendor/modmixer-live/`, ~2–3 weeks — long pole)

- **Connection:** reuse the `BridgeClient` pattern (shared source) plus the
  missing piece: a reader thread parsing newline JSON into a
  `ConcurrentQueue`, drained on the Unity main thread each frame. Needs a
  minimal JSON parser (`Json.cs` is writer-only today).
- **UI:** toggle icon via Harmony postfix on
  `PlaySettings.DoPlaySettingsGlobalControls` (the bottom-right dev-icon
  row) + a `KeyBindingDef`. A `Window` subclass: scrollable transcript of
  user/agent bubbles, one status-ticker line, text field + send. That's the
  whole UI. Window states, rendered prominently:
  - *Connected* — normal chat.
  - *Looking for Modmixer…* — socket retrying (existing backoff loop);
    after ~10s, "Is the Modmixer app running?"
  - *Version mismatch* — "Update Modmixer to use Live" (from
    `server_reject`).
  - *Agent busy* — ticker shows status text; input stays enabled (the app's
    steer-queue handles mid-turn messages).
- **LiveLoader (hot-load engine):** `Assembly.Load(File.ReadAllBytes(dll))`,
  run `[StaticConstructorOnStartup]` types, `PatchAll` under the session
  Harmony id, `UnpatchAll` command, `GenTypes` cache clear via reflection,
  `DefDatabase` registration + def XML hot reload (same code path as the
  vanilla dev action). All executed paused, on the main thread, via
  `LongEventHandler`; any exception → `cmd_result {ok:false}` with message,
  never a half-applied crash.
- **exec_csharp invoker:** load scratch assembly, invoke `Run()` in
  try/catch, arm the `GenSpawn.Spawn` ledger hook for the invocation window.
- **LiveState:** `GameComponent` exposing keyed scribed storage that
  generated code calls into.
- Ships its own `0Harmony.dll` like the bridge (bundled mod; the Workshop
  Harmony dependency is for the later Workshop release).

### C. App-side session flow (TS, ~1 week)

- **"Launch Live Session" button** (Home screen; gated by the experimental
  setting). Flow, reusing existing pieces:
  1. Create a workspace mod from a live-flavored scaffold (empty patch
     class + csproj + pre-warmed scratch csproj), named
     "Live Session – <date>".
  2. Create a conversation bound to it, flagged `live: true`.
  3. Junction-link bridge **and** Live mods — generalize
     `src/agent/bridge-install.ts` (already parameterized in all but
     constants).
  4. Build test savedata + launch with `-quicktest -savedatafolder` (reuse
     `shipAndLaunch` in `src/agent/ship.ts`).
  5. `startMonitoring` binds the conversation for error telemetry
     (existing); LiveServer routes this session's prompts/replies.
- Library presentation: live-session mods grouped under "Live Sessions",
  not mixed with real mods. Presentation-ephemeral, data-persistent.
- Teardown mirrors the bridge (`teardownBridgeInstall` in
  `src/agent/agent-host.ts`): on disconnect after a successful hello,
  unlink the Live mod, stop monitoring, keep the mod folder + chat.

### D. Agent integration (TS, ~1 week)

- **Prompt routing:** `user_prompt` →
  `entry.session.prompt('[in-game] ' + text, { streamingBehavior: 'steer' })`
  — the exact `handleBridgeErrors` pattern (`agent-host.ts:2035`). Bridge
  error auto-prompts flow to the same conversation, so the agent
  self-corrects when a hot load throws in-game.
- **Reply relay:** subscribe to the live conversation's agent events and
  project down to the toy UI: turn start → `agent_busy true`; tool
  executions → ~5 fixed friendly ticker strings ("writing code…",
  "building…", "applying to your game…", "checking for errors…") — never
  raw tool names/args; final assistant message → `agent_say`; turn end →
  `agent_busy false`. Agent questions are final messages of a turn, so they
  land as bubbles naturally.
- **Live tool set** (live-flagged conversations get a modified
  `buildCustomTools()` list in `agent-host.ts`):
  - Keep: path-guarded file tools, `build_mod`, `search_defs`,
    `decompile_dll`, `read_csharp_symbol`, `read_lore`, etc.
  - Add: `apply_live` (build session mod → `unpatch_all` + `hot_load` +
    `reload_defs`, returns cmd_result + any immediate bridge errors) and
    `game_action(code)` (scratch build → `exec_csharp`).
  - Remove: bash, workshop publish, `run_test_cycle`.
- **Live system-prompt section:** code-shape constraints (Harmony + static
  logic + `LiveState`, no custom comp classes), the `game_action` vs
  `apply_live` verb split, snippet contract + sharp edges, status
  discipline (user is in-game: replies 1–3 sentences, no markdown walls),
  the "needs relaunch" escape hatch, and triage rules for hot-load
  failures.

### E. Permissions

Principle: **everything inside the session sandbox is pre-authorized by
clicking Launch; everything outside it is unavailable rather than
prompted** — the user is alt-tabbed into a game and cannot answer app
dialogs.

1. **Feature gate:** experimental toggle in Settings (default off) reveals
   the Launch Live Session button. Existing `requireConsent` applies
   app-wide as today.
2. **Launch = session consent.** First-run confirmation on the button
   states the grant: "Modmixer will build and run code in a sandboxed
   RimWorld session. Your saves and mod list aren't touched. In-game
   prompts use your AI credits like normal chat."
3. **Enforcement at the tool layer, not by trust:** file tools stay
   path-guarded to the session mod folder; bash is absent (removes the
   confirm-gate deadlock structurally); the only mod list ever written is
   the test savedata's.
4. **Spend failures surface in-game:** provider credit/quota errors render
   as a chat bubble ("Modmixer is out of credits — open the app"), not a
   silent stall.
5. **Generated code is unsandboxed by nature** (it's a RimWorld mod — full
   process rights, may do HTTP, e.g. the real-weather example). v1 accepts
   this as identical to normal modding trust, scoped to the isolated
   session. Must be revisited before Live ever touches real colonies
   (v1.5: save backup + scribe guard).

### F. Testing & verification (~3–4 days, overlapping)

- Unit: protocol framing, command sequencing in the reconciler, Live
  install/teardown idempotence (mirror `bridge-install` tests in
  `src/agent/__tests__/`).
- Manual matrix:
  - Both flagship prompts end-to-end (geese one-shot; mood-overlay feature).
  - add → remove → add-unrelated: vanilla behavior fully restored after
    removal (no patch residue).
  - Kill Modmixer mid-session → window degrades to "Looking for Modmixer",
    recovers on app restart.
  - Version mismatch → explicit "update Modmixer" state.
  - Hot-load failure → error auto-prompt → agent fixes → reapply, no
    restart.
  - exec_csharp exception → readable error returned, agent retries.
- `/harness-verify` for live system-prompt behavior (short replies, uses
  `apply_live` instead of asking to relaunch, picks the right verb).

## Sequencing

1. A — protocol + LiveServer.
2. B connection + window UI, against a stub echo server.
3. C — launch flow (button → session mod → game with Live installed).
4. B LiveLoader/exec_csharp + D agent integration, in parallel.
5. E first-run consent + polish.
6. F test matrix.

Rough total: **5–7 weeks**, long pole is the C# engine (workstream B).

## Deferred (v1.5+)

- Detour engine + Cecil diff classifier (enables stateful custom classes
  and method-body swaps on live types).
- `/undo` (the spawn ledger is recorded from day one; the command comes
  later) and snapshot-restore-driven revert of features.
- Real-colony mode (`/modmixer` in any game session, auto-created session
  mods). Requires the real-colony safety work: save backup before first
  change + scribe guard. (The Workshop release itself shipped with v1 as
  the distribution channel; the mod still ships its own 0Harmony.dll
  rather than depending on Pardeike's Workshop Harmony.)
- Promotion flow: "keep this as a real mod" (move out of Live Sessions
  group, normal test/publish lifecycle).
- Texture/audio live reload; in-game eval latency optimization.

## Open questions (non-blocking)

- Launch button placement: Home only (v1 default) vs. also inside an
  existing mod's view (live-iterate on a copy of a real mod).
- Ticker strings: fixed set of five (start here) vs. model-written status
  lines.
- Cleanup policy for abandoned live-session mods (e.g. offer deletion of
  untouched sessions after N days).
