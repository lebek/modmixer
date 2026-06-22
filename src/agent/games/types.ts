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
   * Gates the game in onboarding/settings/library pickers. RimWorld is always
   * available; Minecraft ships behind the `minecraftEnabled` setting for the
   * beta so existing users never see it until we flip the flag.
   */
  beta: boolean;
}
