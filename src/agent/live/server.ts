import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  LIVE_PORT,
  LIVE_PROTOCOL_VERSION,
  type LiveAgentBusy,
  type LiveAgentSay,
  type LiveAgentStatus,
  type LiveCmdResult,
  type LiveCommand,
  type LiveConnectionState,
  type LiveGameMessage,
  type LiveServerHello,
  type LiveServerReject,
} from './protocol.js';

/**
 * Default wait for a command's cmd_result. Hot loads run inside RimWorld's
 * LongEventHandler (def reloads can take a while on big mod lists), so this
 * is deliberately generous — the agent turn is async anyway.
 */
const CMD_TIMEOUT_MS = 120_000;

interface PendingCommand {
  resolve: (result: LiveCmdResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Omit that distributes over a union — plain Omit<LiveCommand, 'id'> would
 * collapse the union to its common keys and reject per-command fields.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends object
  ? Omit<T, K>
  : never;

/**
 * Listens on 127.0.0.1:LIVE_PORT for the in-game Modmixer Live mod.
 *
 * Mirrors MonitorServer's transport behavior (single client, newer
 * connection wins, newline-delimited JSON) but is bidirectional: prompts
 * flow up via the 'prompt' event, commands flow down via sendCommand()
 * with id-correlated cmd_result responses, and agent chat/status pushes go
 * down fire-and-forget via push().
 *
 * Handshake: a live_hello with a protocol we don't speak gets an explicit
 * server_reject (so the in-game window can say "update Modmixer") and the
 * socket is closed; the server keeps listening for a future, matching
 * client.
 */
export class LiveServer extends EventEmitter {
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private state: LiveConnectionState = { kind: 'idle' };
  private buffer = '';
  /** Requested port; 0 in tests means "any free port". */
  private readonly requestedPort: number;
  /** Actual bound port once listening (resolves the port-0 case). */
  private port: number;
  /**
   * In-flight commands by id. Rejected wholesale on disconnect — a command
   * sent to a game that quit mid-apply is a failure the caller must see,
   * not a 120s timeout.
   */
  private pending = new Map<string, PendingCommand>();

  constructor(port: number = LIVE_PORT) {
    super();
    this.requestedPort = port;
    this.port = port;
  }

  start(): void {
    if (this.server) return;
    const server = net.createServer((sock) => this.onConnection(sock));
    server.on('error', (err) => {
      console.error('[live] server error', err);
    });
    server.listen(this.requestedPort, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') this.port = addr.port;
      this.setState({ kind: 'listening', port: this.port });
    });
    this.server = server;
  }

  stop(): void {
    this.rejectAllPending(new Error('Live server stopped.'));
    this.socket?.destroy();
    this.socket = null;
    this.server?.close();
    this.server = null;
    this.setState({ kind: 'idle' });
  }

  getState(): LiveConnectionState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state.kind === 'connected';
  }

  /**
   * Send a command and wait for its cmd_result. Throws immediately when no
   * game is connected (the agent tool surfaces that as "game not running"),
   * on disconnect mid-flight, or after timeoutMs without a result.
   */
  sendCommand(
    cmd: DistributiveOmit<LiveCommand, 'id'> & { id?: string },
    timeoutMs: number = CMD_TIMEOUT_MS,
  ): Promise<LiveCmdResult> {
    if (!this.socket || this.state.kind !== 'connected') {
      return Promise.reject(
        new Error(
          'No live game session connected — the in-game Modmixer Live mod is not attached.',
        ),
      );
    }
    const id = cmd.id ?? randomUUID();
    const full = { ...cmd, id } as LiveCommand;
    return new Promise<LiveCmdResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Live command ${full.type} timed out after ${Math.round(timeoutMs / 1000)}s — the game may be wedged or mid-long-event.`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.writeLine(full)) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Failed to write to the live game socket.'));
      }
    });
  }

  /** Fire-and-forget push (agent chat bubbles, status ticker, busy flag). */
  push(msg: LiveAgentBusy | LiveAgentStatus | LiveAgentSay): void {
    this.writeLine(msg);
  }

  private writeLine(msg: object): boolean {
    const sock = this.socket;
    if (!sock || sock.destroyed) return false;
    try {
      sock.write(JSON.stringify(msg) + '\n');
      return true;
    } catch (err) {
      console.warn('[live] write failed', err);
      return false;
    }
  }

  private setState(next: LiveConnectionState) {
    this.state = next;
    this.emit('state', next);
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onConnection(sock: net.Socket) {
    if (this.socket) {
      // A previous client is still attached. The newer one wins (game
      // restart races, dev iteration) — same semantics as MonitorServer.
      this.socket.destroy();
      this.rejectAllPending(new Error('Live game session replaced.'));
    }
    this.socket = sock;
    this.buffer = '';

    sock.setNoDelay(true);
    sock.setEncoding('utf8');

    const hello: LiveServerHello = {
      type: 'server_hello',
      protocol: LIVE_PROTOCOL_VERSION,
    };
    sock.write(JSON.stringify(hello) + '\n');

    sock.on('data', (chunk: string) => this.onData(sock, chunk));
    sock.on('error', () => {
      // Will fire close right after.
    });
    sock.on('close', () => {
      if (this.socket === sock) {
        this.socket = null;
        this.rejectAllPending(
          new Error('Live game session disconnected mid-command.'),
        );
        this.setState({ kind: 'listening', port: this.port });
      }
    });
  }

  private onData(sock: net.Socket, chunk: string) {
    if (this.socket !== sock) return;
    this.buffer += chunk;
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length > 0) this.handleLine(sock, line);
      nl = this.buffer.indexOf('\n');
    }
  }

  private handleLine(sock: net.Socket, line: string) {
    let msg: LiveGameMessage;
    try {
      msg = JSON.parse(line) as LiveGameMessage;
    } catch (err) {
      console.warn('[live] bad json from game', err);
      return;
    }

    if (msg.type === 'live_hello') {
      if (msg.protocol !== LIVE_PROTOCOL_VERSION) {
        // Explicit refusal so the in-game window can render the reason
        // instead of an eternal "Looking for Modmixer…".
        const reject: LiveServerReject = {
          type: 'server_reject',
          reason: `This game's Modmixer Live mod speaks protocol v${msg.protocol}, but this Modmixer app speaks v${LIVE_PROTOCOL_VERSION}. Update Modmixer (and relaunch the live session) to use Live.`,
        };
        try {
          sock.write(JSON.stringify(reject) + '\n');
        } catch {
          // Best-effort — the close below is what matters.
        }
        sock.end();
        if (this.socket === sock) this.socket = null;
        return;
      }
      this.setState({
        kind: 'connected',
        port: this.port,
        since: Date.now(),
        liveVersion: msg.liveVersion,
        gameStartedAt: msg.gameStartedAt,
      });
    }

    if (msg.type === 'user_prompt') {
      this.emit('prompt', msg);
    }

    if (msg.type === 'cmd_result') {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    }

    this.emit('message', msg);
  }
}

let instance: LiveServer | null = null;

export function getLiveServer(): LiveServer {
  if (!instance) {
    instance = new LiveServer();
    instance.start();
  }
  return instance;
}
