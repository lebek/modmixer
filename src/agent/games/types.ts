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
  /** The build → launch → aggregated-error test loop (both games). */
  testLoop: boolean;
  /** Decompiled/source code index the agent searches (both games). */
  sourceIndex: boolean;
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
  /**
   * Marks a game as still in beta — surfaced as a small "Beta" label in the
   * picker / Games settings card. It does NOT gate availability: every game in
   * getSelectableGames() is always selectable (setup happens lazily).
   */
  beta: boolean;
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
