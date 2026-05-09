---
description: Audit a ModMixer chat session — where context goes, where the model wastes turns, what to fix in the harness.
argument-hint: [mod name or chat title — empty = most recent]
allowed-tools: Bash, Read, Grep, Glob, Skill
---

# /analyze-chat

You are auditing a ModMixer chat session for token efficiency and harness quality. Be quantitative — every claim backed by a tool-call index and a byte count. No code changes in this command; just diagnose.

`$ARGUMENTS` — case-insensitive substring match against the conversation `title` or `scope.modFolder`. If empty, pick the conversation with the largest `updatedAt`.

## 1. Locate the session

The `modmixer-artifacts` skill describes the on-disk layout — invoke it if you need the paths. Read `$env:APPDATA\ModMixer\conversations.json` (Windows). Schema: `{ conversations: [{ id, sessionFile, scope: {type, modFolder?}, title, updatedAt }], activeByMod }`.

- No argument → conversation with the largest `updatedAt`.
- With argument → substring match `title` or `scope.modFolder`. If >1 match, list them with their `updatedAt` and stop. If 0, say so and stop.

Tell the user one line: `Auditing "<title>" — <sessionFile> (<N> records, <KB> total).`

## 2. Build a byte breakdown

Don't `Read` the JSONL — it's large. Stream it with one Bash + Node one-liner. Tally raw line bytes per category:

- `assistant.thinking` — reasoning blocks
- `assistant.text` — user-facing prose
- `assistant.toolCalls` — tool_use args only
- `toolResult.<toolName>` — grouped by the tool that produced them
- `user.text` — real user prompts (exclude tool results & system reminders)
- `system` / `header` — session header, system messages

Also collect from the header (or compute): model name, `thinkingLevel` if present, total user turns, total tool calls, wall-clock duration (first → last record), cost if logged.

## 3. Detect waste patterns

Scan the tool-call stream for:

- **Repeated identical calls** — same tool + same args within ~5 turns.
- **Overlapping reads** — multiple `read`s of the same file with offsets within ~50 lines of each other.
- **Empty / tiny / error results** — results <100 bytes, especially repeated; tools returning errors.
- **Megablocks** — single records >10 KB (top 5 by size, with the tool name).
- **Long thinking** — thinking blocks >5 KB (top 3, with the turn they preceded).

## 4. Report

Emit one markdown report. No preamble. Structure:

```
# <title> — harness audit

**Session**: <model>[ @ thinking=<level>], <N> user turns / <M> tool calls, <duration>, <total KB>. Cost: <$ if known>.

## Phases at a glance
- HH:MM → HH:MM (~Nmin) — <one-line summary of what happened>
- ...

## Where the context is going
\`\`\`
<category>          <KB>   (<%>)   <one-line note if interesting>
...
\`\`\`
By tool (top ~5):
\`\`\`
<tool>             <KB> / <N> calls   worst: #<idx> <KB>
...
\`\`\`

## Where the model wastes turns
- **<pattern>** — concrete evidence: tool-call indices, sizes, what was returned. One short paragraph.
- ...

## What worked
- One or two short bullets — what the harness or model did well. Skip if genuinely nothing.

## Harness improvements (ranked by est. context savings)
1. **<change>** — what + why + rough KB/turn savings on *this* session.
2. ...
```

Rules:
- Sizes in KB to 1 decimal. Percentages of total session bytes.
- Always cite indices (`#42`) when pointing at a problem.
- No code edits — diagnosis only. Implementation is a separate follow-up.
- Total report ≤ ~300 lines. Cut Phases or examples before cutting analysis.
