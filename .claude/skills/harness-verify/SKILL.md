---
name: harness-verify
description: Headlessly A/B-test how a harness change (system prompt, tool, tool-result text, model) affects the agent's behavior, by replaying a REAL ModMixer chat transcript and running the agent's next turn against a chosen model — no GUI, no RimWorld, no manual clicking. Use when you've changed something that should change what the model DOES (e.g. "the agent should now ask before relaunching") and want runtime evidence across variants, not just a typecheck.
---

# harness-verify — headless A/B turn replay

Replays a recorded ModMixer chat up to a chosen point, then runs the agent's
**next turn** headlessly against a chosen model — once per variant, repeated
N times — and reports what the agent *did* (asked the user vs. fired a
side-effecting tool like `run_test_cycle`). This is how you get runtime
evidence that a prompt/tool/hint change actually moves model behavior,
especially for non-frontier models (Kimi etc.) where "it's in the system
prompt" is not the same as "the model obeys it".

It runs the **real** system prompt, the **real** tool set, and the **real**
model + credentials — but in an isolated session with side-effecting tools
swapped for recording stubs, so nothing edits files, builds, launches
RimWorld, or touches the user's conversation store.

## When to use

- You changed how the agent should behave (a system-prompt rule, a tool
  description, a tool-result hint, a model) and want to see the effect.
- You want an A/B: same history + model, with vs. without your change.
- The surface is the agent's decision, and driving the GUI by hand is slow,
  costs RimWorld launches, and isn't repeatable.

Not for: pure mechanical changes with no behavioral question (a typecheck is
enough), or anything where you'd need many full agentic turns with real file
mutation (this stubs the side-effecting tools).

## Run it

```powershell
# Always dry-run first — proves the pipeline (Electron boot, model
# resolution, session reconstruction, prompt build) with ZERO model cost.
node C:\Users\peter\projects\modmixer\scripts\harness\run.mjs `
  --title thunderstorm --until "make it sunny" --dry

# Live A/B: baseline (no change) vs fix (change), 3 turns each.
node C:\Users\peter\projects\modmixer\scripts\harness\run.mjs `
  --title thunderstorm --until "make it sunny" `
  --model moonshotai/kimi-k2.6 --provider openrouter --repeat 3
```

Use an **absolute path** to `run.mjs` (the runner finds the repo from its own
location; the shell cwd is irrelevant and has drifted before).

### Args

| flag | default | meaning |
|---|---|---|
| `--title` | (latest) | case-insensitive substring of the chat `title` / `scope.modFolder`; picks the most-recent match |
| `--until` | `make it sunny` | truncate at the FIRST user message containing this text; that message becomes the replayed turn |
| `--model` | `moonshotai/kimi-k2.6` | model id to run the turn on |
| `--provider` | `openrouter` | provider for the model id |
| `--thinking` | `high` | reasoning level for the turn |
| `--repeat` | `3` | turns per variant (model output is stochastic — repeat to get a rate) |
| `--variants` | `baseline,fix` | `fix` appends `launchModeHint()` to stubbed `build_mod`/`update_schematic` results; `baseline` does not |
| `--dry` | off | bootstrap + reconstruct + print the system prompt's launch-mode + the replay prompt, then exit — no model call |

### Output

Per-variant tallies + a machine-readable `HARNESS_RESULT <json>` line:

```
=== HARNESS SUMMARY ===
baseline : launched-without-asking 3/3, asked/held 0/3, errors 0/3
fix      : launched-without-asking 0/3, asked/held 3/3, errors 0/3
```

`launched-without-asking` = the agent called `run_test_cycle` on its own turn
(there's no user between the truncation point and the call, so any call =
unconfirmed). `asked/held` = it produced text instead (asked, or held).

## How it works

`scripts/harness/run.mjs` (plain Node):
1. Resolves the chat from `%APPDATA%\ModMixer\conversations.json` → `sessionFile` + `scope`.
2. `esbuild`-bundles `replay.ts` into a self-contained **CJS** Electron-main file. CJS so native `require()` resolves Node builtins + external native addons; `import.meta.url` (the SDK uses it) is shimmed to the bundle's own file URL via banner+define. Externals = `electron` + native addons (`better-sqlite3`, `steamworks.js`, ...).
3. Pins `npm_config_arch` to the Electron binary's real arch (same PE probe as `dev-start.mjs` — needed on Windows-on-ARM, where Electron is x64 under Prism).
4. Launches the project's Electron binary on the bundle, passing config + `MM_USERDATA` via env.

`scripts/harness/replay.ts` (Electron main, headless — no window):
1. `bootstrap-userdata.ts` (imported first) repoints `userData` to the real ModMixer dir — otherwise a bare Electron defaults to `%APPDATA%\Electron` and reads no `auth.enc`/settings.
2. Instantiates the real `AgentHost` purely for bootstrap: `primeAfterReady()` loads creds (OpenRouter key from `auth.enc` via DPAPI, or `OPENROUTER_API_KEY`) and registers models.
3. Truncates a temp copy of the transcript before the `--until` user message.
4. Builds the real system prompt (`buildSystemPrompt(scope)`) and the real tool set (`buildCustomTools`), then **stubs** the side-effecting tools (see `STUBBED` in `replay.ts`) with recording no-ops; read-only FS tools (`read`/`ls`/`grep`/`find`) stay real.
5. `createAgentSession(...)` mirroring `AgentHost.constructSession`, then `session.prompt(<the --until message>)` for one turn; reads back `session.agent.state.messages` to see whether `run_test_cycle` was called.

The `fix` vs `baseline` difference is whether the stubbed `build_mod`/`update_schematic` results carry the real `launchModeHint()` text — isolating the hint's behavioral effect on the same model + history.

## Gotchas / limits

- **Cost + stochasticity.** Live runs bill real model tokens. Output varies run-to-run — read the *rate* across `--repeat`, not one run.
- **It's a behavioral probe, not proof.** A stub simulates the side-effecting tool's *result text*; it doesn't run the real edit/build/launch. Good for "does the model decide X", not for verifying the side effect itself.
- **Reachability.** Only tests turns you can reach by truncating an existing transcript. New scenarios need a transcript that contains them.
- **Don't run two Electrons on the same `auth.enc` write path** — reads are fine; the harness only reads creds/settings and writes to a temp session dir.
- safeStorage cross-process decrypt works on Windows (DPAPI, user-scoped). On macOS the Keychain ACL is app-bound, so set `OPENROUTER_API_KEY` in the env there instead.

## Files

- `scripts/harness/run.mjs` — runner (resolve chat, bundle, launch)
- `scripts/harness/replay.ts` — Electron-main harness core
- `scripts/harness/bootstrap-userdata.ts` — first-import userData repoint
- Reuses (exported for this): `buildCustomTools`, `toolDefinitionFromAgentTool` in `src/agent/agent-host.ts`
