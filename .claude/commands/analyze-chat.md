---
description: Audit a ModMixer chat session — where context goes, where the model wastes turns, what to fix in the harness.
argument-hint: [mod name or chat title — empty = most recent]
allowed-tools: Bash, Read, Grep, Glob, Skill
---

# /analyze-chat

Audit a ModMixer chat session. Goal: understand how the session went and what (if anything) the harness should change. You decide how to analyze and what to surface — pick the lens that fits what you actually see.

Lenses worth considering (non-exhaustive — use what fits):
- **Agent intelligence** — did the model understand the request, make good judgment calls, recover from mistakes?
- **Token efficiency** — where is context going, what's wasted, what could be smaller?
- **Tool usage** — right tool for the job, parallelism where possible, avoidable repeats or errors?
- **Harness quality** — system prompt, available tools, skills, hooks — anything missing or misfiring?

`$ARGUMENTS` — case-insensitive substring match against the conversation `title` or `scope.modFolder`. If empty, pick the conversation with the largest `updatedAt`.

## Locate the session

The `modmixer-artifacts` skill describes the on-disk layout — invoke it if you need paths. Read `$env:APPDATA\ModMixer\conversations.json` (Windows). Schema: `{ conversations: [{ id, sessionFile, scope: {type, modFolder?}, title, updatedAt }], activeByMod }`.

- No argument → largest `updatedAt`.
- With argument → substring match. If >1 match, list candidates with `updatedAt` and stop. If 0, say so and stop.

The session file is JSONL and can be large — stream it with Node/Bash rather than `Read`ing the whole thing into context.

## Analyze and report

Up to you. Be concrete — cite tool-call indices, byte counts, turn numbers when they support a point. Skip sections that wouldn't add signal. Keep the report tight; if you're padding, stop.
