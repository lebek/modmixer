/**
 * Minecraft (NeoForge) adapter. A Minecraft mod IS a Gradle project: build is
 * `./gradlew build`, test is `./gradlew runClient` with the diagnostics bridge
 * loaded. No Steam, no ModsConfig, no Prefs — the RimWorld test-loop gotchas do
 * not apply here.
 */
import path from 'node:path';
import fs from 'node:fs';
import { Type } from 'typebox';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { getGame } from '../games/registry.js';
import {
  getWorkspacePaths,
  emptyAbout,
  type AboutMetadata,
} from '../workspace.js';
import { buildMod as buildMinecraftMod } from './gradle.js';
import { syncLicenseFile } from '../license-file.js';
import { launchModeHint } from '../launch-mode.js';
import {
  createMinecraftMod,
  isMinecraftTemplateAvailable,
  readMinecraftMeta,
  writeMinecraftMeta,
} from './scaffold.js';
import {
  isMinecraftClientRunning,
  quitMinecraftClient,
  launchMinecraftClient,
} from './launch.js';
import { resolveCompanions } from './companions.js';
import { minecraftSetup } from './setup.js';
import { buildMinecraftSystemPrompt } from '../system-prompt.js';
import { minecraftResearchTools } from './research-tools.js';
import {
  ensureMinecraftIndexInBackground,
  getMinecraftIndexStatus,
} from '../index/rebuild-minecraft.js';
import type {
  BuildModDetails,
  GameAdapter,
  GameIndexAdapter,
  MetadataWriteResult,
  RunTestCycleDetails,
  TestCycleContext,
} from '../adapters/types.js';

/**
 * Minecraft index: a one-time decompile kicked eagerly at startup so the symbol
 * DB is ready before the first chat — the eager-at-startup intent matches
 * RimWorld. Unlike RimWorld (whose startup build is awaited), the MC build runs
 * in the background, so we ALSO re-kick it per session as a safety net; the
 * `building` guard in ensureMinecraftIndexInBackground dedups the overlap.
 */
const index: GameIndexAdapter = {
  ensureAtStartup: async () => {
    ensureMinecraftIndexInBackground();
  },
  ensureForSession: () => {
    ensureMinecraftIndexInBackground();
  },
  // Honest readiness: the symbol table only exists once a build has produced an
  // index (fresh or stale). It's empty while absent/building, so callers that
  // query without a status check would hit nothing — don't claim ready then.
  symbolDbReady: () => {
    const s = getMinecraftIndexStatus();
    return s === 'fresh' || s === 'stale';
  },
};

const testCycleDescription =
  "Macro: the only way to test the mod in-game. Builds the mod if needed and launches the modded client (./gradlew runClient) with the diagnostics bridge (aggregated, deduped errors streamed back over localhost), then arms background monitoring. If a client is already running it's stopped and relaunched. By default (quicktest) the client drops straight into a freshly-created superflat creative world with the mod loaded — no menu clicks; pass quicktest=false to stop at the title screen instead, or gameMode=\"survival\" for survival. For compat work, pass companionMods to load the user's other installed mods into the SAME dev client. After this returns, tell the user EXACTLY what to try in-game (they're about to alt-tab) — errors arrive automatically as '[automated …]' messages via the error-triage protocol.";

/**
 * Minecraft's run_test_cycle params: the folder, a quicktest knob (RimWorld
 * `-quicktest` parity), its game mode, plus optional compat companion mods.
 */
const minecraftTestCycleParams = Type.Object({
  quicktest: Type.Optional(
    Type.Boolean({
      description:
        "Default true. Drop the user straight into a freshly-created superflat world with the mod loaded (the Minecraft analogue of RimWorld's -quicktest), skipping the title-screen → Create World → Join clicks. The world is regenerated each cycle (no stale state) and cheats are on. Set false ONLY when the test needs the menus or a hand-made world — a custom world type, an existing save, or world-creation/main-menu UI — in which case the client stops at the title screen and the user opens a world themselves.",
    }),
  ),
  gameMode: Type.Optional(
    Type.Union([Type.Literal('creative'), Type.Literal('survival')], {
      description:
        'Game mode for the quicktest world (default "creative"). Use "survival" when the test needs survival mechanics — hunger, mob damage, block-breaking time, mob/loot drops. Ignored when quicktest=false.',
    }),
  ),
  companionMods: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Installed mods to load into the dev client ALONGSIDE the mod under test — for compat work (e.g. "make this work with Create"). Each entry is a modId or name resolved against the user\'s installed mods; get exact ids from list_installed_mods. Their jars are added to the runClient runtime classpath so NeoForge loads them too. NOTE: only the named jars are added, NOT their dependencies — if a companion has required deps, name those as well. A companion built for a different Minecraft/NeoForge version (or a Fabric mod) is flagged and will likely fail to load. Omit for a normal solo test.',
    }),
  ),
});

/** A Minecraft placeholder is a gradle.properties mod id still set to "untitledmod". */
function isPlaceholderMod(modDir: string): boolean {
  return readMinecraftMeta(modDir)?.modId === 'untitledmod';
}

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
          version: meta.version || undefined,
          license: meta.license || undefined,
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
    license: patch.license,
  });
  // Keep a LICENSE file in step with the chosen license (gradle mod_license is
  // the jar-manifest source; this is the human-readable file in the source tree).
  if (patch.license !== undefined) {
    const author =
      patch.author ?? readMinecraftMeta(modDir)?.author ?? '';
    await syncLicenseFile(modDir, patch.license, {
      author,
      year: new Date().getFullYear(),
    });
  }
  if (changed.length === 0) {
    // Not an error: the Settings/Publish UI saves the whole form, and after
    // normalization (id slugified, description flattened) every field can
    // already match what's on disk.
    return {
      changed,
      message: `gradle.properties for ${folder} already matches — nothing to update.`,
    };
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
 * Minecraft mods are Gradle/NeoForge projects: the mod folder *is* the Gradle
 * project root (no Source/ subdir), built with `./gradlew build`.
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
      `No Gradle wrapper in ${modDir} — the NeoForge project is missing or incomplete.`,
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

  // Compat testing: resolve any companion mods to installed jars and load them
  // into the same dev client. Resolution is best-effort — unmatched names and
  // version-mismatched jars are surfaced to the agent, not fatal.
  const companionQueries = Array.isArray(ctx.params.companionMods)
    ? (ctx.params.companionMods as unknown[]).map(String)
    : [];
  let extraMods: string[] = [];
  if (companionQueries.length > 0) {
    const res = await resolveCompanions(companionQueries);
    extraMods = res.jarPaths;
    for (const c of res.resolved) {
      lines.push(
        `Loading companion mod ${c.mod.displayName} (${c.mod.modId})` +
          (c.versionWarning
            ? ` — warning: it ${c.versionWarning}, so it may not load.`
            : '.'),
      );
    }
    if (res.notFound.length > 0) {
      lines.push(
        `Could not find installed mod(s): ${res.notFound.join(
          ', ',
        )} — not loaded. Use list_installed_mods for exact ids.`,
      );
    }
  }

  // Backstop for load-time failures the in-game bridge can't catch: scan the
  // runClient output for NeoForge's mod-loading error block (which aborts the
  // mod bus before the bridge's hooks run, so a broken mod otherwise produces a
  // green build + silence). On first match, collect the error block and steer
  // it into the agent once, so it never wrongly concludes "all good".
  const onLine = makeLoadFailureDetector(ctx);

  // Quicktest (default on): auto-enter a fresh superflat world so the user lands
  // in-game instead of clicking through the menus every cycle. Off → title
  // screen, as before. gameMode picks creative (default) vs survival.
  const quicktestOn = ctx.params.quicktest !== false;
  const gameMode = ctx.params.gameMode === 'survival' ? 'survival' : 'creative';
  const quicktest = quicktestOn ? gameMode : undefined;

  try {
    await launchMinecraftClient(projectDir, { onLine, extraMods, quicktest });
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
      details: { quit, watching: false },
    };
  }

  lines.push(
    'Launched the modded client (gradlew runClient) with the diagnostics bridge. ' +
      (quicktest
        ? `The client is launching and is set to auto-enter a fresh superflat ${quicktest} world (cheats on) with the mod loaded. That's not guaranteed — it may still be booting, and if world entry fails the client stops at the title screen. Do NOT tell the user they're already in-game; ask them to confirm they've landed in the world (or to open one from the menu if they haven't) before relying on repro steps. `
        : 'The client will stop at the title screen; the user opens a world themselves. ') +
      'Watching the bridge in the background; errors will arrive automatically as ' +
      '"[automated …]" messages. Tell the user what to try in-game, then end your turn — ' +
      "don't poll or sleep to wait for errors.",
  );
  return {
    content: [{ type: 'text', text: lines.join(' ') }],
    details: { quit, watching: true },
  };
}

export const MinecraftAdapter: GameAdapter = {
  def: getGame('minecraft'),
  setup: minecraftSetup,
  index,
  toolText: { testCycle: testCycleDescription },
  testCycleParams: minecraftTestCycleParams,
  isPlaceholderMod,
  readModMetadata,
  writeModMetadata,
  createPlaceholder,
  buildSystemPrompt: (scope) => buildMinecraftSystemPrompt(scope),
  researchTools: minecraftResearchTools,
  build,
  test,
};
