/**
 * Wire format between the in-game ModMixer bridge mod (C#) and modmixer.
 *
 * Transport: a TCP server in the modmixer main process listens on
 * 127.0.0.1:BRIDGE_PORT. The bridge mod connects out and exchanges
 * newline-delimited JSON. Each line is exactly one BridgeMessage.
 *
 * The bridge is the data source; modmixer never sends commands today.
 * (Reserved for future "live edit" channels.)
 */

export const BRIDGE_PORT = 13371;
export const BRIDGE_PROTOCOL_VERSION = 1;

/** Server -> client greeting on connect. */
export interface ServerHello {
  type: 'server_hello';
  protocol: number;
}

/** First message from bridge after connect. */
export interface BridgeHello {
  type: 'bridge_hello';
  protocol: number;
  /** Running game version (e.g. RimWorld "1.5" or Minecraft "1.21.1"). */
  gameVersion: string;
  bridgeVersion: string;
  /** ms-since-epoch when the game process started, for uptime math. */
  startedAt: number;
}

/** Sampled ~4Hz. Cheap stuff that should always be moving. */
export interface PerfTick {
  type: 'perf';
  /** RimWorld game tick (Find.TickManager.TicksGame). 0 if no map loaded. */
  gameTick: number;
  /** Game speed: 0=paused, 1=normal, 2=fast, 3=ultra. */
  speed: number;
  /** Smoothed ticks-per-second (target is 60 at speed=1). */
  tps: number;
  /** Smoothed frames-per-second from Unity. */
  fps: number;
  /** Last-frame Unity Time.deltaTime in ms. */
  frameMs: number;
  /** Managed heap size, MB. */
  heapMb: number;
  /** Process working set, MB. */
  workingSetMb: number;
  /** Bridge's own per-tick CPU cost, ms (self-honesty). */
  bridgeMs: number;
}

export interface ModInfo {
  /** ModContentPack.PackageId. */
  packageId: string;
  /** Display name. */
  name: string;
  /** Load order index. */
  loadOrder: number;
  /** True if the mod ships compiled assemblies. */
  hasAssemblies: boolean;
  /** Assembly count (loaded). */
  assemblyCount: number;
  /** Number of Harmony patches owned by this mod (sum across all methods). */
  patchCount: number;
  /** Number of *destructive* prefixes (return-bool prefixes that can short-circuit). */
  destructivePrefixCount: number;
}

export interface PatchEntry {
  /** Fully-qualified patched method (e.g. "Verse.Pawn:Tick"). */
  method: string;
  /** Sorted, comma-joined list of mod names contributing prefixes. */
  prefixes: string[];
  /** Mod names contributing postfixes. */
  postfixes: string[];
  /** Mod names contributing transpilers. */
  transpilers: string[];
  /** Mod names contributing finalizers. */
  finalizers: string[];
  /** Mod names that have a *destructive* prefix on this method. */
  destructiveBy: string[];
}

export interface ConflictEntry {
  /** "double_destructive_prefix", "duplicate_harmony_id", "stacked_transpilers". */
  kind: 'double_destructive_prefix' | 'duplicate_harmony_id' | 'stacked_transpilers';
  /** Mods involved. */
  mods: string[];
  /** Patched method, or harmony id, depending on kind. */
  subject: string;
  /** Human-readable explanation. */
  detail: string;
}

/** Sent on connect and whenever the patch graph changes (e.g. a mod patches lazily). */
export interface ModsSnapshot {
  type: 'mods_snapshot';
  mods: ModInfo[];
  patches: PatchEntry[];
  conflicts: ConflictEntry[];
  /** ms-since-epoch when this snapshot was taken. */
  takenAt: number;
}

export type ErrorSeverity = 'message' | 'warning' | 'error';

export interface ErrorEvent {
  type: 'error_event';
  severity: ErrorSeverity;
  /** First line of the message — short enough for a list row. */
  firstLine: string;
  /** Full message + stack trace if any. */
  text: string;
  /** Mods identified from the stack frames; "Rimworld" for vanilla, "Unknown" if no mod assembly was found. */
  attributedMods: string[];
  /** Stable hash of the stack signature, for client-side dedup. */
  hash: string;
  /** ms-since-epoch. */
  at: number;
}

export type BridgeMessage =
  | BridgeHello
  | PerfTick
  | ModsSnapshot
  | ErrorEvent;

export type ServerMessage = ServerHello;

/** Client-side connection status, surfaced to the renderer. */
export type MonitorConnectionState =
  | { kind: 'idle' }
  | { kind: 'listening'; port: number }
  | {
      kind: 'connected';
      port: number;
      since: number;
      gameVersion: string;
      bridgeVersion: string;
      gameStartedAt: number;
    };
