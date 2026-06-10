/**
 * Wire format between the in-game Modmixer Live mod (C#) and modmixer.
 *
 * Transport: a TCP server in the modmixer main process listens on
 * 127.0.0.1:LIVE_PORT. The Live mod connects out and exchanges
 * newline-delimited JSON, one message per line — same framing as the
 * monitor bridge (see monitor/protocol.ts), but on its OWN port and socket.
 *
 * Why a second channel instead of extending the bridge: the bridge is a
 * passive telemetry tap that gets silently junction-linked into every test
 * session; Live is a command channel that loads and executes compiled code
 * in the running game. Keeping them separate means the powerful half is
 * only ever installed for live sessions the user explicitly launched, and
 * a bug in the experimental engine can't destabilize error monitoring.
 *
 * Unlike the bridge (data flows one way), this protocol is bidirectional:
 * the game sends prompts and command results up; the app sends agent
 * replies and commands down.
 */

export const LIVE_PORT = 13372;
export const LIVE_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Game → app
// ---------------------------------------------------------------------------

/** First message from the Live mod after connect. */
export interface LiveHello {
  type: 'live_hello';
  protocol: number;
  liveVersion: string;
  /** ms-since-epoch when the game process started — same run-identity trick
   *  as the bridge: a reconnect with the same value is a TCP blip, a new
   *  value is a genuinely new game session. */
  gameStartedAt: number;
}

/** The player typed a prompt into the in-game chat window. */
export interface LiveUserPrompt {
  type: 'user_prompt';
  text: string;
  /** ms-since-epoch. */
  at: number;
}

/** Outcome of a LiveCommand, correlated by id. */
export interface LiveCmdResult {
  type: 'cmd_result';
  id: string;
  ok: boolean;
  /** Human/agent-readable outcome: patch counts on success, full exception
   *  text + stack on failure (the agent reads this to iterate). */
  detail: string;
  /** ms-since-epoch. */
  at: number;
}

export type LiveGameMessage = LiveHello | LiveUserPrompt | LiveCmdResult;

// ---------------------------------------------------------------------------
// App → game
// ---------------------------------------------------------------------------

/** Server → client greeting on connect. */
export interface LiveServerHello {
  type: 'server_hello';
  protocol: number;
}

/**
 * Handshake refusal (protocol mismatch). The mod renders `reason` in the
 * chat window ("Update Modmixer to use Live") and stops reconnecting for
 * the rest of the game session, instead of silently failing.
 */
export interface LiveServerReject {
  type: 'server_reject';
  reason: string;
}

/** Turn in flight — the window shows the status ticker while true. */
export interface LiveAgentBusy {
  type: 'agent_busy';
  busy: boolean;
}

/** One-line ticker text ("building…"). Replaces the previous status. */
export interface LiveAgentStatus {
  type: 'agent_status';
  text: string;
}

/** A chat bubble from the agent — the final reply of a turn. */
export interface LiveAgentSay {
  type: 'agent_say';
  text: string;
}

/**
 * Hot-load a freshly built session-mod assembly: UnpatchAll(harmonyId) →
 * Assembly.Load → run [StaticConstructorOnStartup] ctors → PatchAll under
 * harmonyId → clear GenTypes caches → optional def hot-reload. This is one
 * reconciliation step: after it, live behavior == current session-mod
 * source, with no patch residue from earlier iterations.
 */
export interface LiveHotLoadCmd {
  type: 'hot_load';
  id: string;
  dllPath: string;
  harmonyId: string;
  reloadDefs: boolean;
}

/**
 * One-shot action: load a scratch assembly and invoke its static
 * `LiveAction.Run()`. Exceptions come back verbatim in cmd_result.detail.
 */
export interface LiveExecCsharpCmd {
  type: 'exec_csharp';
  id: string;
  dllPath: string;
}

/** Standalone def XML hot-reload, for XML-only iterations. */
export interface LiveReloadDefsCmd {
  type: 'reload_defs';
  id: string;
}

export type LiveCommand = LiveHotLoadCmd | LiveExecCsharpCmd | LiveReloadDefsCmd;

export type LiveAppMessage =
  | LiveServerHello
  | LiveServerReject
  | LiveAgentBusy
  | LiveAgentStatus
  | LiveAgentSay
  | LiveCommand;

/** Client-side connection status, surfaced to the renderer and agent tools. */
export type LiveConnectionState =
  | { kind: 'idle' }
  | { kind: 'listening'; port: number }
  | {
      kind: 'connected';
      port: number;
      since: number;
      liveVersion: string;
      gameStartedAt: number;
    };
