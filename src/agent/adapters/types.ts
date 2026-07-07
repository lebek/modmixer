/**
 * The behavioral half of multi-game support. `src/agent/games/` is the pure,
 * renderer-safe *descriptor* (identity, display, capability flags); this module
 * is the MAIN-PROCESS *adapter* that owns per-game behavior (build, test,
 * scaffold, …). The descriptor says "Minecraft publishes to Modrinth"; the
 * adapter is what actually runs `gradlew` and talks to Modrinth.
 *
 * Why the split: `src/agent/games/` is imported directly by ~10 renderer
 * components, so it must never pull in `electron`/`node:*`. The per-game adapter
 * impls live in their own folder (`<game>/adapter.ts`) and call hard main-only
 * modules (`<game>/*`, `rimworld/ship.ts`, `rimworld/workshop.ts`, …); this file
 * holds only the shared interface, and `adapters/index.ts` the dispatch table.
 *
 * Design rule (matches games/registry.ts): everything dispatches on `GameId`;
 * adding a game means implementing this interface, which the type checker then
 * forces to be complete — no more "forgot to gate" call sites.
 */
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TObject } from 'typebox';
import type {
  GameDefinition,
  GameSetupStatus,
  SetupRequirements,
} from '../games/types.js';
import type { LintFinding } from '../build-lint.js';
import type { BuildErrorHint } from '../build-error-hints.js';
import type { AboutMetadata } from '../workspace.js';
import type { ConversationScope } from '../conversations.js';

export interface BuildModDetails {
  exitCode: number;
  stdout: string;
  stderr: string;
  sourceDir: string;
  /**
   * Non-fatal RimWorld-specific lint findings (e.g. CompTickRare without
   * tickerType). These are advisory — they do not affect the build's exit
   * code. Empty for games without a lint pass (Minecraft).
   */
  lintFindings: LintFinding[];
  /**
   * For failed builds: per-error suggestions resolved against the symbol index
   * (e.g. "missing `using RimWorld.Planet;` for IsWorldPawn"). Empty when the
   * index can't help — never blocks anything.
   */
  errorHints: BuildErrorHint[];
}

export interface RunTestCycleDetails {
  /** Whether a running game instance was force-quit and whether it exited. */
  quit: { wasRunning: boolean; killed: boolean; exited: boolean } | null;
  /** True when background bridge monitoring was armed. */
  watching: boolean;
}

/**
 * Everything a game's test cycle needs, including the host callbacks it must
 * reach. The callbacks are *injected* by the tool wrapper (which has
 * `getAgentHost()` in scope) so adapters never import `agent-host.ts` — that
 * would close an import cycle (agent-host → run_test_cycle tool → adapter).
 */
export interface TestCycleContext {
  conversationId: string;
  /** Workspace mod folder name — the mod the chat is bound to, derived by the
   *  tool wrapper from the session cwd (not a tool param). */
  folder: string;
  /**
   * The validated run_test_cycle tool params for this game, whose shape is the
   * adapter's own `testCycleParams` schema (RimWorld's palette/quicktest/
   * isolated/companionMods, Minecraft's quicktest/gameMode/companionMods) —
   * read by the owning adapter and opaque here, so the shared context never
   * grows a field per game. The tested folder is `folder` above, not in here.
   */
  params: Record<string, unknown>;
  /** Arm the background bridge monitor bound to this conversation. */
  startMonitoring: (args: {
    conversationId: string;
    modFolder: string;
    isolated: boolean;
  }) => Promise<void>;
  /** Steer an automated diagnostic back into the conversation. */
  reportTestDiagnostic: (
    conversationId: string,
    message: string,
  ) => void | Promise<void>;
}

/**
 * Per-game behavior. One implementation per `GameId` in `<game>/adapter.ts`,
 * dispatched by `getAdapter()`. Each method owns a concern that used to be a
 * scattered `if (game === 'minecraft')` branch; the no-game-branches guardrail
 * test keeps new ones from leaking back out.
 */
/**
 * A game's local setup (toolchain provisioning + code-index build) for the
 * Settings → Games card. The adapter knows how to read its own install/index
 * state and produce the uniform, renderer-safe GameSetupStatus.
 */
export interface GameSetupAdapter {
  /** Current setup status (cheap — reads meta/fingerprints, never builds). */
  getStatus(): Promise<GameSetupStatus>;
  /**
   * Probe this game's prerequisites (install detection, toolchain, writable
   * paths, …). Distinct from getStatus() because it's the *expensive* half
   * (fs/exec probes) — callers fetch it on mount + after a fix, not on every
   * build-progress tick. Games without prerequisites return an empty, satisfied
   * set. Shared by onboarding's Setup step and the pre-chat gate.
   */
  checkRequirements(): Promise<SetupRequirements>;
  /**
   * Kick off a (re)build of the index in the background and return the
   * now-building status. `force` rebuilds even when already fresh.
   */
  rebuild(opts?: { force?: boolean }): Promise<GameSetupStatus>;
}

/**
 * Code-index orchestration for a game. Eager games (RimWorld) build at app
 * startup; lazy games (Minecraft) kick a one-time background decompile the first
 * time a chat opens. Keeps the index lifecycle off the shared startup/session
 * code paths.
 */
export interface GameIndexAdapter {
  /** Build/refresh this game's index at app startup (eager games do real work). */
  ensureAtStartup(): Promise<void>;
  /** Kick a background build when a chat opens (lazy games; eager games no-op). */
  ensureForSession(): void;
  /** True when the symbol DB is safe to query without a prior status check. */
  symbolDbReady(): boolean;
}

export interface MetadataWriteResult {
  /** Canonical field names that actually changed (name/packageId/author/description). */
  changed: string[];
  /** Game-specific success line for the tool to surface to the user. */
  message: string;
}

/**
 * Per-game descriptions for the shared tools whose mechanism is game-neutral but
 * whose model-facing copy must name the game's own project shape and workflow.
 */
export interface GameToolText {
  /** run_test_cycle description (RimWorld Prefs/ship/launch vs gradlew runClient). */
  testCycle: string;
}

export interface GameAdapter {
  /** The renderer-safe descriptor (identity, display, capabilities). */
  readonly def: GameDefinition;
  /** Toolchain + index setup status/actions for Settings → Games. */
  readonly setup: GameSetupAdapter;
  /** Code-index lifecycle (startup build, per-session kick, query readiness). */
  readonly index: GameIndexAdapter;
  /** Model-facing description for the shared run_test_cycle tool. */
  readonly toolText: GameToolText;
  /**
   * TypeBox schema for this game's run_test_cycle parameters — the tuning knobs
   * only (RimWorld: palette/quicktest/isolated/companionMods; Minecraft:
   * quicktest/gameMode/companionMods). The shared tool wrapper uses this as the
   * tool's `parameters`, so a game's model never sees another game's knobs. No
   * `folder` field: the tested mod is the one the chat is bound to, and the
   * wrapper derives TestCycleContext.folder from the session cwd.
   */
  readonly testCycleParams: TObject;
  /**
   * Whether `modDir` is still the freshly-minted "Untitled Mod" placeholder
   * (drives the prompt's "name this first" nudge). RimWorld: About.xml with an
   * empty packageId; Minecraft: gradle.properties id "untitledmod".
   */
  isPlaceholderMod(modDir: string): boolean;
  /**
   * Read the mod's display identity into the shared AboutMetadata shape the UI
   * renders. RimWorld reads About.xml; Minecraft maps gradle.properties onto it.
   * Returns null when nothing is readable (caller falls back to a folder name).
   */
  readModMetadata(
    modDir: string,
    folder: string,
  ): Promise<AboutMetadata | null>;
  /**
   * Patch the mod's identity fields. Returns the changed field names plus a
   * game-specific success message. Throws if the mod dir is invalid.
   */
  writeModMetadata(
    modDir: string,
    folder: string,
    patch: Partial<AboutMetadata>,
  ): Promise<MetadataWriteResult>;
  /**
   * Lay down the placeholder identity for a freshly-minted "Untitled Mod" shell
   * (the renderer's "+ new mod" flow). RimWorld writes About.xml + the standard
   * subdirs; Minecraft lays down a buildable NeoForge project from the MDK.
   */
  createPlaceholder(
    modDir: string,
    opts: { author: string },
  ): Promise<void>;
  /**
   * Build the agent's system prompt for this game and conversation scope. The
   * output is frozen into the conversation as a stable cache identifier, so an
   * implementation MUST be deterministic per (scope, settings) — see
   * buildSystemPrompt's invariant in system-prompt.ts.
   */
  buildSystemPrompt(
    scope: ConversationScope,
    opts?: { live?: boolean },
  ): string;
  /**
   * The game's read-only research tool set (installed-mod inspection + the
   * source/def index lookups). Built fresh per session; the shared index/search
   * mechanism lives in tools/*, but each game owns its corpus-specific tool
   * presentation in `<game>/research-tools.ts`.
   */
  researchTools(): AgentTool<any>[];
  /** Compile the mod and return full build output. `signal` may be absent. */
  build(
    modDir: string,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<BuildModDetails>>;
  /** Run the test-in-game flow (ship/launch/watch). */
  test(ctx: TestCycleContext): Promise<AgentToolResult<RunTestCycleDetails>>;
}
