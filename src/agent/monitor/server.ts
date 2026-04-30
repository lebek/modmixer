import net from 'node:net';
import { EventEmitter } from 'node:events';
import {
  BRIDGE_PORT,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeMessage,
  type MonitorConnectionState,
  type ServerHello,
} from './protocol.js';

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

  /** Most recent ModsSnapshot, if any — used to seed the UI on tab open. */
  getLastSnapshot(): BridgeMessage | null {
    for (let i = this.lastSnapshot.length - 1; i >= 0; i--) {
      const m = this.lastSnapshot[i];
      if (m.type === 'mods_snapshot') return m;
    }
    return null;
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

  private handleLine(line: string) {
    let msg: BridgeMessage;
    try {
      msg = JSON.parse(line) as BridgeMessage;
    } catch (err) {
      console.warn('[monitor] bad json from bridge', err);
      return;
    }

    if (msg.type === 'bridge_hello') {
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
