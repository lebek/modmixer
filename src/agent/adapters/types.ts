/**
 * The behavioral half of multi-game support. `src/agent/games/` is the pure,
 * renderer-safe *descriptor* (identity, display, capability flags); this module
 * is the MAIN-PROCESS *adapter* that owns per-game behavior (build, test,
 * scaffold, …). The descriptor says "Minecraft publishes to Modrinth"; the
 * adapter is what actually runs `gradlew` and talks to Modrinth.
 *
 * Why the split: `src/agent/games/` is imported directly by ~10 renderer
 * components, so it must never pull in `electron`/`node:*`. Adapters call hard
 * main-only modules (`minecraft/*`, `ship.ts`, `workshop.ts`, …), so they live
 * here and are imported only by the main process (agent tools, IPC routes).
 *
 * Design rule (matches games/registry.ts): everything dispatches on `GameId`;
 * adding a game means implementing this interface, which the type checker then
 * forces to be complete — no more "forgot to gate" call sites.
 */
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { GameDefinition, GameSetupStatus } from '../games/types.js';
import type { LintFinding } from '../build-lint.js';
import type { BuildErrorHint } from '../build-error-hints.js';
import type { ShipAndLaunchDetails } from '../ship.js';
import type { AboutMetadata } from '../workspace.js';
import type { ConversationScope } from '../conversations.js';

/**
 * Inputs the scaffold_mod tool hands to a game's scaffolder. The tool resolves
 * the target folder (placeholder redirect / orphan guard / mint) and applies
 * the author default; the adapter maps these onto its own project shape
 * (RimWorld → About.xml + subfolders [+ .csproj]; Minecraft → gradle.properties
 * identity in the NeoForge project). RimWorld-only fields are ignored by games
 * that don't use them.
 */
export interface ScaffoldOptions {
  name: string;
  /** RimWorld: reverse-DNS packageId. Minecraft: the mod id (slugified). */
  packageId: string;
  description: string;
  author: string;
  /** RimWorld only — supported game versions for About.xml. */
  rimworldVersions?: string[];
  /** RimWorld only — also emit a buildable .csproj + Mod.cs. */
  withCSharp?: boolean;
}

export interface ScaffoldModDetails {
  modPath: string;
  folder: string;
  files: string[];
  csharp: boolean;
}

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
  /** Prefs.xml mutation result (RimWorld only); null when not applicable. */
  prefs: {
    skipped: boolean;
    skipReason: string | null;
    pinnedNew: string[];
    pinnedAlready: string[];
  } | null;
  /** Sync + launch result; null when we bailed before launching. */
  launch: ShipAndLaunchDetails | null;
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
  /** Workspace mod folder name. */
  folder: string;
  // RimWorld-only debug-session knobs; ignored by games that don't use them.
  paletteEntries?: string[];
  autoOpenPalette?: boolean;
  quicktest?: boolean;
  isolated?: boolean;
  companionMods?: string[];
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
 * Per-game behavior. One implementation per `GameId` in `adapters/{rimworld,
 * minecraft}.ts`, dispatched by `getAdapter()`. Grows one method per concern as
 * we migrate the scattered `if (game === 'minecraft')` branches into here.
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

export interface GameAdapter {
  /** The renderer-safe descriptor (identity, display, capabilities). */
  readonly def: GameDefinition;
  /** Toolchain + index setup status/actions for Settings → Games. */
  readonly setup: GameSetupAdapter;
  /** Code-index lifecycle (startup build, per-session kick, query readiness). */
  readonly index: GameIndexAdapter;
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
  /**
   * Lay down (or re-stamp) the mod's project in `modDir`. The folder is already
   * resolved by the tool; the adapter owns the project shape.
   */
  scaffold(
    modDir: string,
    opts: ScaffoldOptions,
  ): Promise<AgentToolResult<ScaffoldModDetails>>;
  /** Compile the mod and return full build output. `signal` may be absent. */
  build(
    modDir: string,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<BuildModDetails>>;
  /** Run the test-in-game flow (ship/launch/watch). */
  test(ctx: TestCycleContext): Promise<AgentToolResult<RunTestCycleDetails>>;
}
