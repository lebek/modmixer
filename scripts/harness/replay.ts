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

interface HarnessConfig {
  /** Absolute path to the source session JSONL to replay. */
  sessionFile: string;
  /** Conversation scope — drives the real system prompt. */
  scope: ConversationScope;
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
]);

function stubText(
  name: string,
  params: Record<string, unknown>,
  variant: 'baseline' | 'fix',
): string {
  const folder =
    typeof params.folder === 'string' ? params.folder : '<folder>';
  const hint = variant === 'fix' ? launchModeHint() : '';
  switch (name) {
    case 'build_mod':
      return (
        'BUILD SUCCEEDED\n\nBuild succeeded.\n    0 Warning(s)\n    0 Error(s)' +
        hint
      );
    case 'update_schematic':
      return `Updated schematic for ${folder} (shortDescription, body). The Schematic panel reflects this now.${hint}`;
    case 'run_test_cycle':
      return 'Quit running RimWorld instance. Dev mode on. Synced the mod into RimWorld\'s Mods/. Launched RimWorld with -quicktest. Watching the in-game bridge in the background; errors will arrive as auto-prompts.';
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

/** Replace a tool's execute with a recording stub, preserving its schema. */
function stubTool(
  tool: AgentTool<any>,
  variant: 'baseline' | 'fix',
  record: (name: string) => void,
): AgentTool<any> {
  return {
    ...tool,
    execute: async (
      _id: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<unknown>> => {
      record(tool.name);
      return { content: [{ type: 'text', text: stubText(tool.name, params, variant) }] };
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

interface RunOutcome {
  variant: 'baseline' | 'fix';
  toolSequence: string[];
  launched: boolean;
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

  const calls: string[] = [];
  const base = buildCustomTools(
    cwd,
    `harness-${runId}`,
    () => cfg.scope,
    () => model,
    () => [],
  );
  const customTools = base
    .map((t) =>
      STUBBED.has(t.name) ? stubTool(t, variant, (n) => calls.push(n)) : t,
    )
    .map((t) => toolDefinitionFromAgentTool(t));

  const sessionManager = SessionManager.open(tempFile, tempSessionDir, cwd);
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

  const before = session.agent.state.messages.length;
  try {
    await session.prompt(prompt);
  } catch (err) {
    return {
      variant,
      toolSequence: calls,
      launched: calls.includes('run_test_cycle'),
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
  return {
    variant,
    toolSequence: toolNames,
    launched: toolNames.includes('run_test_cycle'),
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
  if (!model) {
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

  const systemPrompt = buildSystemPrompt(cfg.scope);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-harness-'));

  if (cfg.dry) {
    const { prompt } = makeTruncatedSession(cfg, tmpDir, 'dry');
    const askFirst = !systemPrompt.includes('Launch mode — proactive');
    console.log(
      JSON.stringify(
        {
          dry: true,
          model: `${model.provider}/${model.id}`,
          systemPromptChars: systemPrompt.length,
          systemPromptLaunchMode: askFirst ? 'ask-first' : 'proactive',
          replayPrompt: prompt,
          hintFixVariant: launchModeHint().trim(),
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
        `[harness]   → ${r.launched ? 'LAUNCHED (run_test_cycle)' : 'no launch'}; tools: [${r.toolSequence.join(', ')}]${r.error ? '; ERROR: ' + r.error : ''}\n`,
      );
    }
  }

  const summarize = (v: 'baseline' | 'fix') => {
    const rs = results.filter((r) => r.variant === v);
    return {
      variant: v,
      runs: rs.length,
      launchedWithoutAsking: rs.filter((r) => r.launched).length,
      askedOrHeld: rs.filter((r) => !r.launched && !r.error).length,
      errors: rs.filter((r) => r.error).length,
    };
  };
  const summary = {
    model: `${model.provider}/${model.id}`,
    thinkingLevel: cfg.thinkingLevel ?? 'high',
    perVariant: cfg.variants.map(summarize),
    runs: results,
  };
  console.log('\n=== HARNESS SUMMARY ===');
  for (const s of summary.perVariant) {
    console.log(
      `${s.variant.padEnd(9)}: launched-without-asking ${s.launchedWithoutAsking}/${s.runs}, asked/held ${s.askedOrHeld}/${s.runs}, errors ${s.errors}/${s.runs}`,
    );
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
