import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  BRIDGE_PORT,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeMessage,
  type ErrorEvent,
  type ErrorSeverity,
  type MonitorConnectionState,
  type ServerHello,
} from './protocol.js';

/** Server-side accumulator for one error class — by stack-signature hash. */
export interface ErrorBucket {
  hash: string;
  severity: ErrorSeverity;
  firstLine: string;
  /** Full text (message + stack trace) from the most recent occurrence. */
  text: string;
  attributedMods: string[];
  count: number;
  firstAt: number;
  lastAt: number;
}

/**
 * Safety cap on retained buckets within a single run. Buckets are dropped
 * wholesale when a new game session starts (see runId handling), so this
 * only guards the pathological single-run case (hundreds of distinct stack
 * signatures in one test). 200 is far above any healthy run.
 */
const ERROR_BUCKET_CAP = 200;

/**
 * Listens on 127.0.0.1:BRIDGE_PORT for the in-game bridge to connect.
 *
 * Single-client semantics: if a second connection arrives, we close the older
 * one (game restart races, dev iteration). Newline-delimited JSON in both
 * directions; we currently only send a server_hello on connect.
 */
export class MonitorServer extends EventEmitter {
  private server: net.Server | null = null;
  private socket: net.Socket | null = null;
  private state: MonitorConnectionState = { kind: 'idle' };
  private lastSnapshot: BridgeMessage[] = [];
  private buffer = '';
  /**
   * Server-side error retention for the *current run*. Keyed by hash for
   * O(1) lookup via getErrorByHash, which backs the agent's
   * monitor_get_error tool.
   *
   * Lifetime is the run, not the socket: buckets are dropped only when a
   * genuinely new game session connects (a new `startedAt` — see
   * handleLine). They deliberately survive a disconnect so the agent can
   * still drill into the run it just observed after the user quits the
   * game, and survive a transient TCP reconnect mid-session.
   */
  private errorBuckets = new Map<string, ErrorBucket>();

  /**
   * Monotonic run counter. A "run" is one game session — one process the
   * user launched via run_test_cycle. Incremented when a bridge connects
   * with a `startedAt` we haven't seen, i.e. a real relaunch (a bare TCP
   * reconnect keeps the same `startedAt` and the same run). Surfaced to the
   * agent in every auto-prompt and drill-in so it can tell whether an error
   * is from before or after its last fix+relaunch.
   */
  private runId = 0;
  /** `startedAt` of the game session that owns the current run, if any. */
  private runStartedAt: number | null = null;

  start(): void {
    if (this.server) return;
    const server = net.createServer((sock) => this.onConnection(sock));
    server.on('error', (err) => {
      console.error('[monitor] server error', err);
    });
    server.listen(BRIDGE_PORT, '127.0.0.1', () => {
      this.setState({ kind: 'listening', port: BRIDGE_PORT });
    });
    this.server = server;
  }

  stop(): void {
    this.socket?.destroy();
    this.socket = null;
    this.server?.close();
    this.server = null;
    this.setState({ kind: 'idle' });
  }

  getState(): MonitorConnectionState {
    return this.state;
  }

  /**
   * Id of the current run (one game session). 0 before any game has
   * connected. The errorBuckets always belong to this run.
   */
  getRunId(): number {
    return this.runId;
  }

  /** Most recent ModsSnapshot, if any — used to seed the UI on tab open. */
  getLastSnapshot(): BridgeMessage | null {
    for (let i = this.lastSnapshot.length - 1; i >= 0; i--) {
      const m = this.lastSnapshot[i];
      if (m.type === 'mods_snapshot') return m;
    }
    return null;
  }

  /**
   * Look up a retained error class by hash. The hash is the bridge's stable
   * stack-signature key (see ErrorsChannel.HashFromStack on the C# side) —
   * the agent receives it in the auto-prompted summary and passes it to the
   * monitor_get_error tool to drill into the full text + stack.
   */
  getErrorByHash(hash: string): ErrorBucket | null {
    return this.errorBuckets.get(hash) ?? null;
  }

  /** Snapshot of all retained buckets, ordered most-recent-first. */
  getErrorBuckets(): ErrorBucket[] {
    return Array.from(this.errorBuckets.values()).sort(
      (a, b) => b.lastAt - a.lastAt,
    );
  }

  private setState(next: MonitorConnectionState) {
    this.state = next;
    this.emit('state', next);
  }

  private onConnection(sock: net.Socket) {
    if (this.socket) {
      // A previous bridge is still attached. The newer one wins.
      this.socket.destroy();
    }
    this.socket = sock;
    this.buffer = '';

    sock.setNoDelay(true);
    sock.setEncoding('utf8');

    const hello: ServerHello = {
      type: 'server_hello',
      protocol: BRIDGE_PROTOCOL_VERSION,
    };
    sock.write(JSON.stringify(hello) + '\n');

    sock.on('data', (chunk: string) => this.onData(chunk));
    sock.on('error', () => {
      // Will fire close right after.
    });
    sock.on('close', () => {
      if (this.socket === sock) {
        this.socket = null;
        this.lastSnapshot = [];
        // errorBuckets are NOT cleared here — they belong to the run, not
        // the socket. They survive until a genuinely new game session
        // connects (handleLine), so the agent can still drill into the run
        // it just watched, and a transient TCP reconnect doesn't lose them.
        this.setState({ kind: 'listening', port: BRIDGE_PORT });
      }
    });
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length > 0) this.handleLine(line);
      nl = this.buffer.indexOf('\n');
    }
  }

  private ingestErrorEvent(msg: ErrorEvent): void {
    const existing = this.errorBuckets.get(msg.hash);
    if (existing) {
      existing.count += 1;
      existing.lastAt = msg.at;
      // Refresh text/severity from the latest occurrence — long-running
      // sessions could see a warning re-emit with a new variant string from
      // the same call site, and the freshest snapshot is more useful for
      // triage than the first one we ever saw.
      existing.severity = msg.severity;
      existing.firstLine = msg.firstLine;
      existing.text = msg.text;
      existing.attributedMods = msg.attributedMods;
      return;
    }
    if (this.errorBuckets.size >= ERROR_BUCKET_CAP) {
      // Evict the oldest entry by lastAt — Map preserves insertion order,
      // but `lastAt` is more meaningful as "least recently active".
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, b] of this.errorBuckets) {
        if (b.lastAt < oldestAt) {
          oldestAt = b.lastAt;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) this.errorBuckets.delete(oldestKey);
    }
    this.errorBuckets.set(msg.hash, {
      hash: msg.hash,
      severity: msg.severity,
      firstLine: msg.firstLine,
      text: msg.text,
      attributedMods: msg.attributedMods,
      count: 1,
      firstAt: msg.at,
      lastAt: msg.at,
    });
  }

  private handleLine(line: string) {
    let msg: BridgeMessage;
    try {
      msg = JSON.parse(line) as BridgeMessage;
    } catch (err) {
      console.warn('[monitor] bad json from bridge', err);
      return;
    }

    if (msg.type === 'bridge_hello') {
      // A `startedAt` we haven't seen means a genuinely new game process —
      // start a new run and drop the previous run's errors. The same
      // `startedAt` means the bridge merely reconnected (TCP blip); keep
      // the run and its error history intact.
      if (this.runStartedAt !== msg.startedAt) {
        this.runStartedAt = msg.startedAt;
        this.runId += 1;
        this.errorBuckets.clear();
        this.emit('run', this.runId);
      }
      this.setState({
        kind: 'connected',
        port: BRIDGE_PORT,
        since: Date.now(),
        rimworldVersion: msg.rimworldVersion,
        bridgeVersion: msg.bridgeVersion,
        gameStartedAt: msg.startedAt,
      });
    }

    if (msg.type === 'mods_snapshot') {
      this.lastSnapshot = [msg];
    }

    if (msg.type === 'error_event') {
      this.ingestErrorEvent(msg);
    }

    this.emit('message', msg);
  }
}

let instance: MonitorServer | null = null;

export function getMonitorServer(): MonitorServer {
  if (!instance) {
    instance = new MonitorServer();
    instance.start();
  }
  return instance;
}
