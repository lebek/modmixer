/**
 * Headless A/B turn-replay harness (Electron main process).
 *
 * Loads a real ModMixer chat transcript, truncates it to a chosen point,
 * then runs the agent's NEXT turn headlessly against a chosen model — once
 * per variant, repeated N times — and reports what action the agent took
 * (asked the user vs. fired a side-effecting tool). Built to answer
 * "does this harness/prompt/tool change actually change the model's
 * behavior?" without the GUI, without launching RimWorld, without touching
 * the user's real mod or conversation files.
 *
 * Why Electron (not plain Node): the real system prompt, tools, settings,
 * and the OpenRouter credential all go through Electron-coupled code
 * (app.getPath, safeStorage) and native modules built for Electron's ABI
 * (better-sqlite3). Running inside the real electron binary is the only way
 * to reuse that path faithfully. We instantiate the real AgentHost purely
 * for its bootstrap (auth + model registration), then build an isolated
 * session that mirrors AgentHost.constructSession with side-effecting tools
 * swapped for recording stubs.
 *
 * Config arrives as JSON in MM_HARNESS_CONFIG (see HarnessConfig). Output is
 * a single line `HARNESS_RESULT <json>` on stdout plus a human summary.
 */
// FIRST import — repoints userData to the real ModMixer dir before any
// ModMixer module can call app.getPath('userData').
import './bootstrap-userdata.js';
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  SessionManager,
  createAgentSession,
  type AgentSession,
} from '@mariozechner/pi-coding-agent';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import {
  AgentHost,
  buildCustomTools,
  toolDefinitionFromAgentTool,
} from '../../src/agent/agent-host.js';
import { buildSystemPrompt } from '../../src/agent/system-prompt.js';
import { ScopedResourceLoader } from '../../src/agent/resource-loader.js';
import { launchModeHint } from '../../src/agent/launch-mode.js';
import type { ConversationScope } from '../../src/agent/conversations.js';
import type { GameId } from '../../src/agent/games/types.js';

interface HarnessConfig {
  /** Absolute path to the source session JSONL to replay. */
  sessionFile: string;
  /** Conversation scope — drives the real system prompt. */
  scope: ConversationScope;
  /**
   * Game for the conversation. Drives which system prompt + tool set is built
   * (RimWorld default; Minecraft for NeoForge chats) and which run_test_cycle
   * result text the stub returns. Defaults to rimworld.
   */
  game?: GameId;
  /** Model to run the turn on. */
  model: { provider: string; modelId: string };
  /** Reasoning level for the turn. */
  thinkingLevel?: string;
  /**
   * Truncate history at the FIRST user message whose text includes this
   * substring; that message becomes the prompt for the replayed turn. The
   * agent then takes its next turn from there.
   */
  untilUserText: string;
  /**
   * Replay a live-session conversation: live system prompt + live tool set,
   * apply_live/game_action stubbed. In live mode the variants A/B the
   * SYSTEM PROMPT (baseline strips the "Interpret before you implement"
   * block back to the pre-fix text) instead of the launch-mode hint, and the
   * outcome classifier looks at WHAT the agent built (the named thing vs. a
   * vanilla lookalike, plus drama/flavor touches) rather than run_test_cycle.
   */
  live?: boolean;
  /** Variants to run. 'fix' appends launchModeHint() to stubbed build/schematic results; 'baseline' does not. */
  variants: Array<'baseline' | 'fix'>;
  /** Times to repeat each variant (model output is stochastic). */
  repeat: number;
  /** When true, bootstrap + reconstruct only; do NOT call the model. */
  dry?: boolean;
}

/**
 * Tools we replace with recording stubs so a replayed turn never edits
 * files, builds, launches RimWorld, hits the index DB, or shows toasts. The
 * stub returns a realistic success string so the model proceeds as if it
 * ran. Read-only filesystem tools (read/ls/grep/find) are left REAL — they
 * only read the workspace and give the model accurate context.
 */
const STUBBED = new Set<string>([
  'bash',
  'edit',
  'write',
  'scaffold_mod',
  'set_mod_metadata',
  'update_schematic',
  'build_mod',
  'run_test_cycle',
  'notify_test_status',
  'monitor_get_error',
  'monitor_poll',
  'list_installed_mods',
  'decompile_dll',
  'render_svg_to_png',
  'render_preview',
  'search_defs',
  'read_csharp_symbol',
  'search_source',
  'save_lore',
  'read_lore',
  // Live-session tools — never talk to a real game from the harness.
  'apply_live',
  'game_action',
]);

function stubText(
  name: string,
  params: Record<string, unknown>,
  variant: 'baseline' | 'fix',
  live: boolean,
  game: GameId,
): string {
  const folder =
    typeof params.folder === 'string' ? params.folder : '<folder>';
  // In live mode the variant difference lives in the system prompt, not the
  // tool-result hint — appending launchModeHint would confound the A/B.
  const hint = variant === 'fix' && !live ? launchModeHint() : '';
  switch (name) {
    case 'apply_live':
      return params.defsOnly === true
        ? 'Defs hot-reloaded in the running game. defs reloaded'
        : 'Applied live (assembly LiveSessionHotharness1). loaded LiveSessionHotharness1: 0 methods patched, 0 static ctors run; defs reloaded';
    case 'game_action':
      return 'Action ran in-game. Result: done; spawned 0 things';
    case 'build_mod':
      return (
        'BUILD SUCCEEDED\n\nBuild succeeded.\n    0 Warning(s)\n    0 Error(s)' +
        hint
      );
    case 'update_schematic':
      return `Updated schematic for ${folder} (shortDescription, body). The Schematic panel reflects this now.${hint}`;
    case 'run_test_cycle':
      if (game === 'minecraft') {
        return (
          'Launched the modded client (gradlew runClient) with the diagnostics bridge. ' +
          'The first run decompiles Minecraft and can take several minutes. ' +
          'Watching the bridge in the background; errors will arrive automatically as ' +
          '"[automated …]" messages. Tell the user what to try in-game, then end your turn — ' +
          "don't poll or sleep to wait for errors."
        );
      }
      return 'Quit running RimWorld instance. Dev mode on. Synced the mod into RimWorld\'s Mods/. Launched RimWorld with -quicktest. Watching the in-game bridge in the background; errors will arrive as auto-prompts.';
    case 'monitor_poll':
      // Realistic "armed, nothing yet" so the model decides naturally whether
      // to keep polling (the buggy loop) or end its turn.
      return '# test run #1 — game connected\nNo errors captured in this run.';
    case 'edit':
      return 'Successfully replaced 1 block(s).';
    case 'write':
      return 'Successfully wrote file.';
    case 'set_mod_metadata':
      return `Updated About.xml for ${folder}. The Settings panel reflects this now.`;
    case 'notify_test_status':
      return 'Toast shown.';
    case 'read_lore':
      return '(lore omitted in harness)';
    default:
      return `(${name} stubbed in harness — no-op)`;
  }
}

interface RecordedCall {
  name: string;
  params: Record<string, unknown>;
}

/** Replace a tool's execute with a recording stub, preserving its schema. */
function stubTool(
  tool: AgentTool<any>,
  variant: 'baseline' | 'fix',
  live: boolean,
  game: GameId,
  record: (call: RecordedCall) => void,
): AgentTool<any> {
  return {
    ...tool,
    execute: async (
      _id: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> => {
      record({ name: tool.name, params });
      return {
        content: [
          { type: 'text', text: stubText(tool.name, params, variant, live, game) },
        ],
      };
    },
  };
}

/** Parse the JSONL into {raw line, parsed record}. */
function readSessionLines(file: string): Array<{ raw: string; rec: any }> {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((raw) => {
      try {
        return { raw, rec: JSON.parse(raw) };
      } catch {
        return { raw, rec: null };
      }
    });
}

function recordText(rec: any): string {
  const msg = rec?.message ?? rec;
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join(' ');
  }
  return '';
}

/**
 * Write a truncated copy of the session: every line BEFORE the first user
 * message matching `untilUserText`. Returns the matched user text (the
 * prompt for the replayed turn) and the temp file path.
 */
function makeTruncatedSession(
  cfg: HarnessConfig,
  tmpDir: string,
  runId: string,
): { tempFile: string; prompt: string } {
  const lines = readSessionLines(cfg.sessionFile);
  let cutIndex = -1;
  let prompt = '';
  for (let i = 0; i < lines.length; i++) {
    const { rec } = lines[i];
    const msg = rec?.message ?? rec;
    if (rec?.type === 'message' && msg?.role === 'user') {
      const text = recordText(rec);
      if (text.toLowerCase().includes(cfg.untilUserText.toLowerCase())) {
        cutIndex = i;
        prompt = text;
        break;
      }
    }
  }
  if (cutIndex < 0) {
    throw new Error(
      `No user message matching "${cfg.untilUserText}" found in ${cfg.sessionFile}`,
    );
  }
  const kept = lines.slice(0, cutIndex).map((l) => l.raw);
  const tempFile = path.join(tmpDir, `replay-${runId}.jsonl`);
  fs.writeFileSync(tempFile, kept.join('\n') + (kept.length ? '\n' : ''));
  return { tempFile, prompt };
}

// ── Live-mode prompt variants ───────────────────────────────────────────────
// The change under test is the "Interpret before you implement" block in the
// live scope prompt (plus the reworded "Two verbs" header). baseline strips
// those exact edits from the freshly built prompt, yielding the pre-change
// text. Exact-string surgery on purpose: if the prompt drifts and a marker
// stops matching, the A/B is no longer testing what it claims to — fail
// loudly instead.

const INTERPRET_START = '\n\nInterpret before you implement';
const INTERPRET_END = 'note the touches you added in your report.';

const FIX_TWO_VERBS =
  "Two verbs — once you know what you're building, classify it:";
const OLD_TWO_VERBS = 'Two verbs — classify every request first:';

function promptForVariant(
  builtPrompt: string,
  variant: 'baseline' | 'fix',
  live: boolean,
): string {
  if (variant === 'fix') return builtPrompt;
  if (!live) return builtPrompt;
  const startIdx = builtPrompt.indexOf(INTERPRET_START);
  const endIdx = builtPrompt.indexOf(INTERPRET_END);
  if (!builtPrompt.includes(FIX_TWO_VERBS) || startIdx < 0 || endIdx < startIdx) {
    throw new Error(
      'live baseline variant: fix markers not found in the built system prompt — prompt text drifted, update the markers in replay.ts',
    );
  }
  return (
    builtPrompt.slice(0, startIdx) +
    builtPrompt.slice(endIdx + INTERPRET_END.length)
  ).replace(FIX_TWO_VERBS, OLD_TWO_VERBS);
}

/**
 * Live-mode outcome for the interpret-block A/B (cheese-meteor replay): did
 * the turn build the thing the user actually named (cheese), stage it with
 * RimWorld's drama machinery (skyfaller/meteorite/incident/letter), and add a
 * flavor touch (thought/memory/hediff) — or substitute the nearest vanilla
 * lookalike (the gold-ore meteorite)? Matches against every string the agent
 * sent into stubbed tools (game_action code, write/edit content, …).
 */
function classifyLiveOutcome(calls: RecordedCall[]): string {
  const blob = calls.map((c) => JSON.stringify(c.params ?? {})).join('\n');
  if (!blob.trim()) return 'no-action';
  if (!/cheese/i.test(blob)) {
    return /gold/i.test(blob) ? 'substitute-gold' : 'substitute-other';
  }
  const extras = [
    /skyfaller|meteorite|incident|letter/i.test(blob) ? 'drama' : null,
    /thought|memory|hediff/i.test(blob) ? 'flavor' : null,
  ].filter(Boolean);
  return extras.length ? `cheese+${extras.join('+')}` : 'cheese-plain';
}

interface RunOutcome {
  variant: 'baseline' | 'fix';
  toolSequence: string[];
  launched: boolean;
  outcome: string;
  finalText: string;
  error?: string;
}

async function runOneTurn(
  host: AgentHost,
  model: any,
  cfg: HarnessConfig,
  systemPrompt: string,
  variant: 'baseline' | 'fix',
  tmpDir: string,
): Promise<RunOutcome> {
  const cwd = (host as any).cwd as string;
  const agentDir = (host as any).agentDir as string;
  const runId = randomUUID().slice(0, 8);
  const { tempFile, prompt } = makeTruncatedSession(cfg, tmpDir, runId);
  const tempSessionDir = path.join(tmpDir, `sessions-${runId}`);
  fs.mkdirSync(tempSessionDir, { recursive: true });

  const live = cfg.live === true;
  const game: GameId = cfg.game ?? 'rimworld';
  const calls: RecordedCall[] = [];
  const base = buildCustomTools(
    cwd,
    `harness-${runId}`,
    () => cfg.scope,
    () => model,
    () => [],
    { live, game },
  );
  const customTools = base
    .map((t) =>
      STUBBED.has(t.name)
        ? stubTool(t, variant, live, game, (c) => calls.push(c))
        : t,
    )
    .map((t) => toolDefinitionFromAgentTool(t));

  const sessionManager = SessionManager.open(tempFile, tempSessionDir, cwd);
  const resourceLoader = new ScopedResourceLoader(
    promptForVariant(systemPrompt, variant, live),
    [],
  );
  const { session } = (await createAgentSession({
    cwd,
    agentDir,
    authStorage: (host as any).authStorage,
    modelRegistry: (host as any).modelRegistry,
    settingsManager: (host as any).settingsManager,
    sessionManager,
    resourceLoader,
    model,
    thinkingLevel: (cfg.thinkingLevel as any) ?? 'high',
    tools: (host as any).allowedToolNames,
    customTools,
  })) as { session: AgentSession };

  const before = session.agent.state.messages.length;
  try {
    await session.prompt(prompt);
  } catch (err) {
    return {
      variant,
      toolSequence: calls.map((c) => c.name),
      launched: calls.some((c) => c.name === 'run_test_cycle'),
      outcome: 'error',
      finalText: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Derive the agent's action from the messages it appended this turn.
  const newMsgs = session.agent.state.messages.slice(before);
  const toolNames: string[] = [];
  let finalText = '';
  for (const m of newMsgs) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as any[]) {
      if (b?.type === 'toolCall' && typeof b.name === 'string') {
        toolNames.push(b.name);
      } else if (b?.type === 'text' && typeof b.text === 'string') {
        finalText += b.text;
      }
    }
  }
  const launched = toolNames.includes('run_test_cycle');
  // Minecraft test-cycle scenario: the question isn't whether it launched but
  // what it did AFTER — ending the turn (push-based, correct) vs. babysitting
  // with monitor_poll / bash-sleep loops (the bug). Any monitor_poll or bash
  // call after a launch is the buggy pattern.
  const polledAfterLaunch =
    launched &&
    toolNames.some((n, i) => i > toolNames.indexOf('run_test_cycle') && (n === 'monitor_poll' || n === 'bash'));
  let outcome: string;
  if (live) {
    outcome = classifyLiveOutcome(calls);
  } else if (game === 'minecraft') {
    outcome = !launched
      ? 'no-launch'
      : polledAfterLaunch
        ? 'launched-then-polled'
        : 'launched-then-ended';
  } else {
    outcome = launched ? 'launched-without-asking' : 'asked/held';
  }
  return {
    variant,
    toolSequence: toolNames,
    launched,
    outcome,
    finalText: finalText.trim(),
  };
}

async function main(): Promise<void> {
  const cfg: HarnessConfig = JSON.parse(process.env.MM_HARNESS_CONFIG ?? '{}');
  await app.whenReady();
  // Headless: never open a window.
  const host = new AgentHost(() => null);
  host.primeAfterReady();

  const reg = (host as any).modelRegistry;
  const model =
    reg.find?.(cfg.model.provider, cfg.model.modelId) ??
    reg
      .getAll()
      .find(
        (m: any) =>
          m.provider === cfg.model.provider && m.id === cfg.model.modelId,
      );
  if (!model && !cfg.dry) {
    const available = reg
      .getAll()
      .map((m: any) => `${m.provider}/${m.id}`)
      .slice(0, 40);
    console.error(
      `[harness] model ${cfg.model.provider}/${cfg.model.modelId} not registered. Available:\n` +
        available.join('\n'),
    );
    app.exit(3);
    return;
  }

  const live = cfg.live === true;
  const game: GameId = cfg.game ?? 'rimworld';
  const systemPrompt = buildSystemPrompt(cfg.scope, { live, game });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-harness-'));

  if (cfg.dry) {
    const { prompt, tempFile } = makeTruncatedSession(cfg, tmpDir, 'dry');
    const askFirst = !systemPrompt.includes('Launch mode — proactive');
    // Exercise the variant transform in dry mode so a marker drift fails
    // here, before any model spend. Marker drift is orthogonal to the tool
    // dump, so don't let it abort the run — record it instead.
    let baselinePromptChars = -1;
    let baselineTransformError: string | null = null;
    try {
      baselinePromptChars = promptForVariant(systemPrompt, 'baseline', live).length;
    } catch (err) {
      baselineTransformError = err instanceof Error ? err.message : String(err);
    }
    // Build the EXACT tool set the live turn would send to the model, so we
    // can confirm which tools are actually in the payload for this scope/game.
    const cwd = (host as any).cwd as string;
    const toolSet = buildCustomTools(
      cwd,
      'harness-dry',
      () => cfg.scope,
      () => model ?? null,
      () => [],
      { live, game },
    );
    const toolNames = toolSet.map((t) => t.name).sort();
    // GROUND TRUTH: construct the session exactly like a live turn (mirrors
    // runOneTurn / AgentHost.constructSession) and read back the tool list pi
    // actually resolves into `agent.state.tools` — i.e. what gets sent to the
    // model. This closes the gap between "buildCustomTools returns X" and "pi
    // exposes X to the model". No prompt() call, so no model spend.
    let sessionToolNames: string[] | null = null;
    let sessionToolsError: string | null = null;
    try {
      const agentDir = (host as any).agentDir as string;
      const customTools = toolSet.map((t) => toolDefinitionFromAgentTool(t));
      const sessionManager = SessionManager.open(
        tempFile,
        path.join(tmpDir, 'sessions-dry'),
        cwd,
      );
      const resourceLoader = new ScopedResourceLoader(systemPrompt, []);
      const { session } = (await createAgentSession({
        cwd,
        agentDir,
        authStorage: (host as any).authStorage,
        modelRegistry: (host as any).modelRegistry,
        settingsManager: (host as any).settingsManager,
        sessionManager,
        resourceLoader,
        model,
        thinkingLevel: (cfg.thinkingLevel as any) ?? 'high',
        tools: (host as any).allowedToolNames,
        customTools,
      })) as { session: AgentSession };
      sessionToolNames = (session.agent.state.tools ?? [])
        .map((t: any) => t?.name)
        .filter((n: any): n is string => typeof n === 'string')
        .sort();
    } catch (err) {
      sessionToolsError = err instanceof Error ? err.message : String(err);
    }
    console.log(
      JSON.stringify(
        {
          dry: true,
          live,
          game,
          model: model ? `${model.provider}/${model.id}` : '(not registered — dry)',
          systemPromptChars: systemPrompt.length,
          baselinePromptChars,
          baselineTransformError,
          systemPromptLaunchMode: askFirst ? 'ask-first' : 'proactive',
          replayPrompt: prompt,
          hintFixVariant: live ? '(n/a in live mode)' : launchModeHint().trim(),
          toolCount: toolNames.length,
          toolNames,
          hasInspectMod: toolNames.includes('inspect_mod'),
          systemPromptMentionsInspectMod: systemPrompt.includes('inspect_mod'),
          // Ground truth from the constructed session (what the model receives):
          sessionToolCount: sessionToolNames ? sessionToolNames.length : null,
          sessionToolNames,
          sessionHasInspectMod: sessionToolNames
            ? sessionToolNames.includes('inspect_mod')
            : null,
          sessionToolsError,
        },
        null,
        2,
      ),
    );
    console.log('HARNESS_RESULT ' + JSON.stringify({ dry: true, ok: true }));
    app.exit(0);
    return;
  }

  const results: RunOutcome[] = [];
  for (const variant of cfg.variants) {
    for (let i = 0; i < cfg.repeat; i++) {
      process.stderr.write(`[harness] ${variant} run ${i + 1}/${cfg.repeat}…\n`);
      const r = await runOneTurn(
        host,
        model,
        cfg,
        systemPrompt,
        variant,
        tmpDir,
      );
      results.push(r);
      process.stderr.write(
        `[harness]   → ${r.outcome}; tools: [${r.toolSequence.join(', ')}]${r.error ? '; ERROR: ' + r.error : ''}\n`,
      );
    }
  }

  const summarize = (v: 'baseline' | 'fix') => {
    const rs = results.filter((r) => r.variant === v);
    const outcomes: Record<string, number> = {};
    for (const r of rs) {
      outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    }
    return {
      variant: v,
      runs: rs.length,
      outcomes,
      launchedWithoutAsking: rs.filter((r) => r.launched).length,
      askedOrHeld: rs.filter((r) => !r.launched && !r.error).length,
      errors: rs.filter((r) => r.error).length,
    };
  };
  const summary = {
    model: `${model.provider}/${model.id}`,
    thinkingLevel: cfg.thinkingLevel ?? 'high',
    live,
    perVariant: cfg.variants.map(summarize),
    runs: results,
  };
  console.log('\n=== HARNESS SUMMARY ===');
  for (const s of summary.perVariant) {
    const tally = Object.entries(s.outcomes)
      .map(([k, n]) => `${k} ${n}/${s.runs}`)
      .join(', ');
    console.log(`${s.variant.padEnd(9)}: ${tally}`);
  }
  console.log('HARNESS_RESULT ' + JSON.stringify(summary));
  app.exit(0);
}

main().catch((err) => {
  console.error('[harness] fatal:', err);
  try {
    app.exit(1);
  } catch {
    process.exit(1);
  }
});
