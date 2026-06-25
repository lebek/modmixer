/**
 * Minecraft (NeoForge) adapter. A Minecraft mod IS a Gradle project: build is
 * `./gradlew build`, test is `./gradlew runClient` with the diagnostics bridge
 * loaded. No Steam, no ModsConfig, no Prefs — the RimWorld test-loop gotchas do
 * not apply here.
 */
import path from 'node:path';
import fs from 'node:fs';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import { getGame } from '../games/registry.js';
import {
  getWorkspacePaths,
  emptyAbout,
  type AboutMetadata,
} from '../workspace.js';
import { buildMod as buildMinecraftMod } from '../minecraft/gradle.js';
import { launchModeHint } from '../launch-mode.js';
import {
  createMinecraftMod,
  isMinecraftTemplateAvailable,
  readMinecraftMeta,
  writeMinecraftMeta,
} from '../minecraft/scaffold.js';
import {
  isMinecraftClientRunning,
  quitMinecraftClient,
  launchMinecraftClient,
} from '../minecraft/launch.js';
import { minecraftSetup } from '../minecraft/setup.js';
import { buildMinecraftSystemPrompt } from '../system-prompt.js';
import { minecraftResearchTools } from '../minecraft/research-tools.js';
import type {
  BuildModDetails,
  GameAdapter,
  MetadataWriteResult,
  RunTestCycleDetails,
  ScaffoldModDetails,
  ScaffoldOptions,
  TestCycleContext,
} from './types.js';

/**
 * Minecraft identity lives in gradle.properties; map it onto the shared
 * AboutMetadata shape the UI renders (folder name as a fallback). Never null —
 * an un-scaffolded folder still shows a sensible placeholder name.
 */
function readModMetadata(
  modDir: string,
  folder: string,
): Promise<AboutMetadata | null> {
  const meta = readMinecraftMeta(modDir);
  return Promise.resolve(
    meta
      ? {
          ...emptyAbout(meta.name || 'Untitled Mod'),
          packageId: meta.modId,
          author: meta.author,
          description: meta.description,
        }
      : emptyAbout(folder),
  );
}

/** Patch gradle.properties (renaming the id rebrands the whole project). */
async function writeModMetadata(
  modDir: string,
  folder: string,
  patch: Partial<AboutMetadata>,
): Promise<MetadataWriteResult> {
  const changed = await writeMinecraftMeta(modDir, {
    name: patch.name,
    author: patch.author,
    description: patch.description,
    modId: patch.packageId,
  });
  if (changed.length === 0) {
    throw new Error('set_mod_metadata called with no fields to update.');
  }
  return {
    changed,
    message: `Updated gradle.properties for ${folder} (${changed.join(', ')}). The mod's name/id now reflect this${
      changed.includes('modId')
        ? ' — the @Mod id, package, and resource namespaces were renamed to match'
        : ''
    }.`,
  };
}

/**
 * A Minecraft mod IS a Gradle/NeoForge project — lay down a buildable one from
 * the vendored MDK so the agent edits a working project from message zero. If
 * the template isn't vendored yet we leave an empty folder; the build/test tools
 * surface a clear "run fetch:neoforge-mdk" error.
 */
async function createPlaceholder(
  modDir: string,
  opts: { author: string },
): Promise<void> {
  if (!isMinecraftTemplateAvailable()) return;
  await createMinecraftMod(modDir, {
    modId: 'untitledmod',
    modName: 'Untitled Mod',
    author: opts.author,
    description: '',
  });
}

/**
 * A Minecraft mod IS a NeoForge/Gradle project. In the normal flow the renderer
 * already laid one down (createUntitledMod → createMinecraftMod at "+ new mod"
 * time), so scaffold here RE-STAMPS identity into gradle.properties rather than
 * re-copying the MDK template (which would clobber the agent's work). It only
 * lays down a fresh project when the folder has none — e.g. a mod-less chat, or
 * recovery when the template wasn't vendored at create time. Either way it never
 * writes RimWorld files (About.xml/.csproj) into the project.
 */
async function scaffold(
  modDir: string,
  opts: ScaffoldOptions,
): Promise<AgentToolResult<ScaffoldModDetails>> {
  const folder = path.basename(modDir);
  const idSource = opts.packageId || opts.name;
  if (readMinecraftMeta(modDir)) {
    // Project already present — re-stamp identity (renaming the id rebrands the
    // project so @Mod + package + namespaces stay matched). No template copy.
    const changed = await writeMinecraftMeta(modDir, {
      name: opts.name,
      author: opts.author,
      description: opts.description,
      modId: idSource,
    });
    const text =
      changed.length > 0
        ? `Updated the NeoForge project identity (${changed.join(', ')}) at ${modDir}. Edit src/main/java and src/main/resources from here.`
        : `The NeoForge project at ${modDir} is already scaffolded. Edit src/main/java and src/main/resources, or set its name/id with set_mod_metadata.`;
    return {
      content: [{ type: 'text', text }],
      details: { modPath: modDir, folder, files: [], csharp: false },
    };
  }
  await createMinecraftMod(modDir, {
    modId: idSource,
    modName: opts.name,
    author: opts.author,
    description: opts.description,
  });
  return {
    content: [
      {
        type: 'text',
        text:
          `Scaffolded a NeoForge project at ${modDir}. Identity lives in gradle.properties ` +
          '(set name/id via set_mod_metadata); write Java under src/main/java and data/asset JSON ' +
          'under src/main/resources. build_mod / run_test_cycle drive the bundled ./gradlew.',
      },
    ],
    details: { modPath: modDir, folder, files: [], csharp: false },
  };
}

/**
 * Minecraft mods are Gradle/NeoForge projects: the mod folder *is* the Gradle
 * project root (no Source/ subdir), built with `./gradlew build`. The first
 * build decompiles Minecraft and can take many minutes — that's expected.
 */
async function build(
  modDir: string,
  signal?: AbortSignal,
): Promise<AgentToolResult<BuildModDetails>> {
  const hasWrapper =
    fs.existsSync(path.join(modDir, 'gradlew')) ||
    fs.existsSync(path.join(modDir, 'gradlew.bat'));
  if (!hasWrapper) {
    throw new Error(
      `No Gradle wrapper in ${modDir}. Use scaffold_mod to lay down the NeoForge project first.`,
    );
  }
  const result = await buildMinecraftMod(modDir, undefined, signal);
  const exitCode = result.ok ? 0 : 1;
  const status = result.ok
    ? `BUILD SUCCEEDED${result.jarPath ? ` → ${result.jarPath}` : ''}`
    : 'BUILD FAILED';
  // On a green build only — mirror the RimWorld build's launch-policy reminder
  // so the user's autoLaunch setting governs Minecraft testing too. A red
  // build's next step is fixing errors, not testing, so it gets no hint.
  const text =
    `${status}\n\n${result.output}` + (result.ok ? launchModeHint() : '');
  return {
    content: [{ type: 'text', text }],
    details: {
      exitCode,
      stdout: result.output,
      stderr: '',
      sourceDir: modDir,
      lintFindings: [],
      errorHints: [],
    },
  };
}

// Distinctive markers in NeoForge/FML output when mod loading fails. These show
// the in-game "Error loading mods" screen; the text also lands in the runClient
// console, which is what we scan.
const LOAD_FAILURE_RE =
  /Error loading mods|ModLoadingException|ModLoadingIssue|which does not exist or is not in the same file|Missing or unsupported mandatory|Failed to load|incompatible mods|caught exception during loading/i;

/**
 * Build a line handler that watches runClient output for a mod-loading failure
 * block and, on first sight, steers a concise diagnostic into the agent exactly
 * once. Collects up to ~60 lines from the first marker, flushing after a short
 * idle so the whole FML error block is captured.
 */
function makeLoadFailureDetector(
  ctx: TestCycleContext,
): (line: string) => void {
  let collecting = false;
  let reported = false;
  const block: string[] = [];
  let timer: NodeJS.Timeout | null = null;

  const flush = () => {
    if (reported) return;
    reported = true;
    if (timer) clearTimeout(timer);
    const detail = block.join('\n').slice(0, 4000);
    void ctx.reportTestDiagnostic(
      ctx.conversationId,
      `[automated — test run] The Minecraft client failed to load the mod (NeoForge "Error loading mods" screen). Reported by the loader:\n\n${detail}\n\nThis is a load-time error (the build compiled fine). Diagnose the cause from the message above — a common one is a mod-id/entrypoint mismatch — fix it, then run the test again.`,
    );
  };

  return (line: string) => {
    if (reported) return;
    if (!collecting && LOAD_FAILURE_RE.test(line)) collecting = true;
    if (!collecting) return;
    block.push(line);
    if (block.length >= 60) {
      flush();
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 2500);
  };
}

/**
 * Minecraft test cycle: arm the shared bridge monitor, then launch the modded
 * client with `gradlew runClient` (the bridge mod streams aggregated errors
 * back over localhost). Fire-and-forget — the client runs until the user closes
 * it; errors arrive as auto-prompts meanwhile. (The bridge's wall-clock
 * auto-exit watchdog is intentionally NOT armed here: it's a non-interactive
 * smoke-test mode that exits the moment the title screen loads, which would cut
 * an interactive test short. It stays available behind `testTimeoutMs` for a
 * future automated check.)
 */
async function test(
  ctx: TestCycleContext,
): Promise<AgentToolResult<RunTestCycleDetails>> {
  const lines: string[] = [];

  let quit: RunTestCycleDetails['quit'] = null;
  if (isMinecraftClientRunning()) {
    await quitMinecraftClient();
    quit = { wasRunning: true, killed: true, exited: true };
    lines.push('Stopped the previous test client.');
  }

  // Arm the monitor BEFORE launching so the bridge can connect as the client
  // boots (the bridge also retries with backoff, so order is forgiving).
  await ctx.startMonitoring({
    conversationId: ctx.conversationId,
    modFolder: ctx.folder,
    isolated: false,
  });

  const { workspaceDir } = getWorkspacePaths();
  const projectDir = path.join(workspaceDir, ctx.folder);

  // Backstop for load-time failures the in-game bridge can't catch: scan the
  // runClient output for NeoForge's mod-loading error block (which aborts the
  // mod bus before the bridge's hooks run, so a broken mod otherwise produces a
  // green build + silence). On first match, collect the error block and steer
  // it into the agent once, so it never wrongly concludes "all good".
  const onLine = makeLoadFailureDetector(ctx);

  try {
    await launchMinecraftClient(projectDir, { onLine });
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Failed to launch the Minecraft client: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ],
      details: { quit, prefs: null, launch: null, watching: false },
    };
  }

  lines.push(
    'Launched the modded client (gradlew runClient) with the diagnostics bridge. ' +
      'The first run decompiles Minecraft and can take several minutes. Errors will ' +
      'arrive automatically as "[automated …]" messages; tell the user what to try in-game.',
  );
  return {
    content: [{ type: 'text', text: lines.join(' ') }],
    details: { quit, prefs: null, launch: null, watching: true },
  };
}

export const MinecraftAdapter: GameAdapter = {
  def: getGame('minecraft'),
  setup: minecraftSetup,
  readModMetadata,
  writeModMetadata,
  createPlaceholder,
  buildSystemPrompt: (scope) => buildMinecraftSystemPrompt(scope),
  researchTools: minecraftResearchTools,
  scaffold,
  build,
  test,
};
