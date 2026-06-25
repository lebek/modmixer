/**
 * Multi-game support — the declarative description of a game ModMixer can make
 * mods for. ModMixer began as a RimWorld-only tool; this module is the seam
 * that lets a second game (Minecraft Java + NeoForge) coexist without breaking
 * existing RimWorld users.
 *
 * Design rule: everything here is *additive and behaviour-preserving*. RimWorld
 * keeps its existing direct code paths; new games get new branches that dispatch
 * on `GameId`. Anything that reads a per-mod or per-conversation game defaults
 * to `'rimworld'`, so a mod created before this field existed behaves exactly as
 * it did before.
 */

/** Stable identifier persisted in mod prefs, conversations, and settings. */
export type GameId = 'rimworld' | 'minecraft';

/** Where a finished mod is published. `null` = publishing not wired for this game. */
export type PublishTarget = 'steam-workshop' | 'modrinth' | null;

/** Which build/test toolchain a game uses (drives env detection + agent rules). */
export type BuildTool = 'dotnet' | 'gradle';

/**
 * Capability flags gate UI surfaces and agent tools per game. A feature that is
 * hard (or not yet worth) supporting for a new game is switched off here rather
 * than special-cased at every call site. For the Minecraft beta the asset/sprite
 * panel and the in-game live-edit session are intentionally off.
 */
export interface GameCapabilities {
  /** Steam Workshop publish + Steamworks process coupling (RimWorld only). */
  steamWorkshop: boolean;
  /** External host a successful publish uploads to. */
  publish: PublishTarget;
  /** The Textures/Sounds asset-requirement panel + sprite preview rendering. */
  assetPanel: boolean;
  /**
   * The mod-dependency / load-order editor panel (RimWorld About.xml
   * modDependencies + loadAfter/Before). RimWorld-specific; a Minecraft mod's
   * dependencies live in the generated neoforge.mods.toml, which has no panel.
   */
  depsPanel: boolean;
  /** In-game live hot-edit session (RimWorld Verse bridge); off for MC beta. */
  liveSession: boolean;
  /**
   * Crowd-sourced community lore sync (push user lore, pull curated entries).
   * RimWorld-only for now; other games read only their shipped bundle, so the
   * runtime `repo` tier never swaps to an empty community cache.
   */
  communityLore: boolean;
  /**
   * Import an existing on-disk mod folder into the workspace. RimWorld-only —
   * the importer synthesizes a RimWorld About.xml; other games have no
   * equivalent loose-folder layout to ingest.
   */
  folderImport: boolean;
  /**
   * The test loop installs a Modmixer bridge mod into the game's real config
   * (RimWorld: a Mods/ junction + ModsConfig entry) that must be torn down when
   * the test session ends. Minecraft loads its bridge via gradlew runClient, so
   * there is nothing to clean up.
   */
  testBridgeInstall: boolean;
  /**
   * The mod header shows a "running game" indicator + quit control (RimWorld runs
   * as a long-lived process ModMixer can detect/quit). Minecraft's runClient is a
   * Gradle subprocess with no such affordance.
   */
  runningGameControl: boolean;
  /**
   * The schematic panel scans the mod's authored XML defs for a Definitions
   * section. RimWorld stores defs as Defs/*.xml; Minecraft keeps data as JSON
   * under src/main/resources, so the section is hidden.
   */
  defScan: boolean;
}

/**
 * A game's lore taxonomy — the topic slots and one-line routing hints the agent
 * sees when reading/saving transferable modding lessons. Pure data, co-located
 * with the game's descriptor in `<game>/lore-taxonomy.ts`.
 */
export interface LoreTaxonomy {
  /** Topic catalogue for this game's lore (ordered; `misc` last). */
  topics: readonly string[];
  /** One-line hint per topic, shown in read_lore/save_lore docs + the prompt. */
  topicHints: Record<string, string>;
}

/**
 * The declarative half of a game. Behaviour (detect paths, launch, build, index,
 * publish) is dispatched per-game in the modules that own those concerns; this
 * record carries the identity, display, and capability data shared everywhere.
 */
export interface GameDefinition {
  id: GameId;
  /** Short product name shown to users, e.g. "RimWorld", "Minecraft". */
  displayName: string;
  /** Disambiguating label for chips/badges, e.g. "Minecraft (NeoForge)". */
  shortLabel: string;
  /** Tailwind classes for the home-tile / tab game badge. */
  badgeClassName: string;
  capabilities: GameCapabilities;
  buildTool: BuildTool;
  /** Topic taxonomy for this game's transferable-lesson lore. */
  lore: LoreTaxonomy;
  /** Per-game titles for the index build phases shown in the setup/progress UI. */
  indexPhaseLabels: {
    toolchain: string;
    defs: string;
    decompile: string;
    symbols: string;
  };
  /**
   * Onboarding setup step ids inserted between game-picker and the AI step.
   * Both games run the single game-neutral `'setup'` step (prerequisite checks +
   * source-index build); the field stays an array so a future game can insert
   * extra bespoke steps without reworking the flow.
   */
  setupSteps: readonly string[];
  /**
   * Sub-path segment for this game's on-disk storage (code index, lore, caches)
   * under their shared base dirs. RimWorld is `''` — it owns the legacy
   * un-namespaced root so existing indexes/lore aren't invalidated; every other
   * game nests under its own segment (e.g. `'minecraft'`). Append with
   * `seg ? join(base, seg) : base` so RimWorld stays at the root.
   */
  storageSegment: string;
  /**
   * Marks a game as still in beta — surfaced as a small "Beta" label in the
   * picker / Games settings card. It does NOT gate availability: every game in
   * getSelectableGames() is always selectable (setup happens lazily).
   */
  beta: boolean;
}

/**
 * Severity of a setup prerequisite. `required` failures also stop the index
 * build from starting (it physically can't build — e.g. no install); both tiers
 * block the pre-chat gate. The distinction lets onboarding allow deferring the
 * recommended ones while the new-mod gate insists on every check being green.
 */
export type SetupRequirementSeverity = 'required' | 'recommended';

/**
 * A renderer-safe remediation a requirement row offers. The adapter is
 * main-only and can't hand the renderer a callback, so it names a structured
 * action the shared body maps onto an existing IPC (browse/launch/open-url) and
 * always re-checks afterward.
 */
export interface SetupAction {
  kind: 'browse-install' | 'launch-game' | 'open-url';
  /** Button label, e.g. "Browse…", "Launch RimWorld", "Install". */
  label: string;
  /** Target for kind === 'open-url'. */
  url?: string;
}

/**
 * How a prerequisite gets satisfied.
 * - `manual` (default): the user must act (install RimWorld, launch to create
 *   ModsConfig, install a dev-only tool). The row shows a fix action and gates
 *   per its severity.
 * - `auto`: ModMixer provisions it itself, just-in-time, the first time it's
 *   needed (JDK 21 at the first index build, the .NET SDK at the first C# build).
 *   The row is informational — found-on-system vs will-be-installed — and NEVER
 *   blocks the user or the build, because the build is what provisions it.
 */
export type SetupProvisioning = 'manual' | 'auto';

/** One prerequisite check shown as a row in the shared setup body. */
export interface SetupRequirement {
  /** Stable id (e.g. 'install', 'mods-config', 'dotnet'). */
  id: string;
  label: string;
  severity: SetupRequirementSeverity;
  /** Default 'manual' when omitted. */
  provisioning?: SetupProvisioning;
  ok: boolean;
  /** Explanation when not ok (or a resolved path when ok). */
  detail: string | null;
  /** Short caption under the label, e.g. the resolved path. */
  hint?: string | null;
  /** Optional fix the renderer surfaces as a button (manual rows only). */
  action?: SetupAction | null;
}

/**
 * A game's prerequisite checks, produced by its adapter (main-only — it probes
 * the install/toolchain) and rendered generically. Games whose only needs are
 * auto-provisioned (Minecraft's JDK) still surface those as informational rows;
 * `satisfied`/`allOk` ignore them because the build handles them.
 */
export interface SetupRequirements {
  items: SetupRequirement[];
  /**
   * Every blocking `required` item is ok — the index build may proceed. Auto
   * items never block (the build provisions them).
   */
  satisfied: boolean;
  /**
   * Every blocking item is ok — the gate can stay silent. Auto items never
   * block; their completion is implied by the index reaching `fresh`.
   */
  allOk: boolean;
}

/**
 * Roll a list of requirement rows up into a SetupRequirements verdict. Auto rows
 * are never blockers (the build provisions them just-in-time), so only `manual`
 * rows count toward `satisfied`/`allOk`. Pure — shared by every game's adapter.
 */
export function summarizeRequirements(
  items: SetupRequirement[],
): SetupRequirements {
  const blocks = (r: SetupRequirement) =>
    (r.provisioning ?? 'manual') !== 'auto' && !r.ok;
  return {
    items,
    satisfied: !items.some((r) => r.severity === 'required' && blocks(r)),
    allOk: !items.some(blocks),
  };
}

/** Live state of a game's local setup (toolchain + code index). */
export type GameSetupState =
  | 'absent' // never built
  | 'building' // (re)build in progress
  | 'fresh' // built and current
  | 'stale' // built but out of date (game/toolchain changed)
  | 'blocked'; // can't build — a prerequisite is missing (e.g. no install)

/** A labeled key/value shown in a game's setup card, e.g. "Defs" → "1,234". */
export interface GameSetupFact {
  label: string;
  value: string;
}

/**
 * Uniform, renderer-safe description of a game's setup status. Produced by the
 * game's adapter (main-only, which knows how to detect the install + read the
 * index meta) and rendered generically by Settings → Games. A new game surfaces
 * its own state/facts/copy here without any renderer or IPC changes — this is
 * what keeps the per-game setup cards symmetric and additive.
 */
export interface GameSetupStatus {
  state: GameSetupState;
  /** One-line status sentence. */
  headline: string;
  /** Why setup can't proceed (only when state === 'blocked'). */
  blockedReason?: string;
  /** Longer copy describing what "setup" does for this game. */
  detail?: string;
  /** Pre-formatted facts shown once set up (version, counts, size, built-at). */
  facts: GameSetupFact[];
  /** Whether the rebuild button is enabled. */
  canRebuild: boolean;
  /** Rebuild button label, e.g. "Rebuild" or "Set up Minecraft". */
  rebuildLabel: string;
}

/**
 * A game's setup status plus the most recent build-progress event, so the
 * renderer (onboarding step + pre-chat gate) can render granular per-phase
 * progress for any game off one snapshot. Symmetric with the RimWorld-only
 * IndexSnapshot, but game-tagged and adapter-driven.
 */
export interface GameSetupSnapshot {
  status: GameSetupStatus;
  lastProgress: import('../index/progress').IndexProgressEvent | null;
}
