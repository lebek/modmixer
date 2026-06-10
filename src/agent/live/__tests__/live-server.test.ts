import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { LiveServer } from '../server.js';
import {
  LIVE_PROTOCOL_VERSION,
  type LiveCmdResult,
  type LiveConnectionState,
  type LiveUserPrompt,
} from '../protocol.js';

/** Loosely-typed server line — tests assert on a handful of fields. */
interface ServerLine {
  type: string;
  protocol?: number;
  reason?: string;
  id?: string;
}

/**
 * Minimal fake of the in-game Live client: a raw TCP socket speaking
 * newline-delimited JSON, with a line queue the tests can await.
 */
class FakeGameClient {
  private socket: net.Socket;
  private buffer = '';
  private lines: ServerLine[] = [];
  private waiters: ((line: ServerLine) => void)[] = [];

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl = this.buffer.indexOf('\n');
      while (nl !== -1) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (line) {
          const parsed = JSON.parse(line) as ServerLine;
          const waiter = this.waiters.shift();
          if (waiter) waiter(parsed);
          else this.lines.push(parsed);
        }
        nl = this.buffer.indexOf('\n');
      }
    });
  }

  static async connect(port: number): Promise<FakeGameClient> {
    const socket = net.connect(port, '127.0.0.1');
    await once(socket, 'connect');
    return new FakeGameClient(socket);
  }

  send(msg: object): void {
    this.socket.write(JSON.stringify(msg) + '\n');
  }

  hello(overrides: Partial<Record<string, unknown>> = {}): void {
    this.send({
      type: 'live_hello',
      protocol: LIVE_PROTOCOL_VERSION,
      liveVersion: '0.1.0',
      gameStartedAt: 1234,
      ...overrides,
    });
  }

  nextLine(timeoutMs = 2000): Promise<ServerLine> {
    const queued = this.lines.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for a line from the server')),
        timeoutMs,
      );
      this.waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }

  destroy(): void {
    this.socket.destroy();
  }
}

function waitForState(
  server: LiveServer,
  kind: LiveConnectionState['kind'],
  timeoutMs = 2000,
): Promise<LiveConnectionState> {
  if (server.getState().kind === kind) {
    return Promise.resolve(server.getState());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for state ${kind}`)),
      timeoutMs,
    );
    const handler = (s: LiveConnectionState) => {
      if (s.kind !== kind) return;
      clearTimeout(timer);
      server.off('state', handler);
      resolve(s);
    };
    server.on('state', handler);
  });
}

describe('LiveServer', () => {
  let server: LiveServer;
  let port: number;
  let clients: FakeGameClient[];

  beforeEach(async () => {
    // Port 0 → ephemeral, so parallel test runs never collide on the real
    // LIVE_PORT.
    server = new LiveServer(0);
    server.start();
    const state = await waitForState(server, 'listening');
    assert.ok(state.kind === 'listening');
    port = state.port;
    clients = [];
  });

  afterEach(() => {
    for (const c of clients) c.destroy();
    server.stop();
  });

  async function connect(): Promise<FakeGameClient> {
    const c = await FakeGameClient.connect(port);
    clients.push(c);
    return c;
  }

  it('handshakes: server_hello out, connected state after live_hello', async () => {
    const client = await connect();
    const hello = await client.nextLine();
    assert.equal(hello.type, 'server_hello');
    assert.equal(hello.protocol, LIVE_PROTOCOL_VERSION);

    client.hello();
    const state = await waitForState(server, 'connected');
    assert.ok(state.kind === 'connected');
    assert.equal(state.liveVersion, '0.1.0');
    assert.equal(state.gameStartedAt, 1234);
  });

  it('rejects a protocol mismatch with server_reject and stays listening', async () => {
    const client = await connect();
    await client.nextLine(); // server_hello
    client.hello({ protocol: LIVE_PROTOCOL_VERSION + 1 });
    const reject = await client.nextLine();
    assert.equal(reject.type, 'server_reject');
    assert.match(reject.reason ?? '', /Update Modmixer/i);
    assert.notEqual(server.getState().kind, 'connected');
  });

  it('emits prompt events for user_prompt messages', async () => {
    const client = await connect();
    await client.nextLine();
    client.hello();
    await waitForState(server, 'connected');

    const prompted = new Promise<LiveUserPrompt>((resolve) =>
      server.once('prompt', resolve),
    );
    client.send({ type: 'user_prompt', text: 'geese please', at: 5 });
    const prompt = await prompted;
    assert.equal(prompt.text, 'geese please');
  });

  it('correlates sendCommand with its cmd_result by id', async () => {
    const client = await connect();
    await client.nextLine();
    client.hello();
    await waitForState(server, 'connected');

    const pending = server.sendCommand({ type: 'reload_defs' });
    const cmd = await client.nextLine();
    assert.equal(cmd.type, 'reload_defs');
    assert.ok(typeof cmd.id === 'string' && cmd.id.length > 0);

    // An unrelated result id must NOT settle the pending command.
    client.send({
      type: 'cmd_result',
      id: 'someone-else',
      ok: true,
      detail: 'nope',
      at: 1,
    });
    client.send({
      type: 'cmd_result',
      id: cmd.id,
      ok: true,
      detail: 'defs reloaded',
      at: 2,
    });
    const result: LiveCmdResult = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.detail, 'defs reloaded');
  });

  it('rejects pending commands when the game disconnects', async () => {
    const client = await connect();
    await client.nextLine();
    client.hello();
    await waitForState(server, 'connected');

    const pending = server.sendCommand({ type: 'reload_defs' });
    await client.nextLine(); // the command reached the wire
    client.destroy();
    await assert.rejects(pending, /disconnected/);
  });

  it('refuses sendCommand with no game connected', async () => {
    await assert.rejects(
      server.sendCommand({ type: 'reload_defs' }),
      /No live game session connected/,
    );
  });

  it('newer connection wins; the old socket is dropped', async () => {
    const first = await connect();
    await first.nextLine();
    first.hello();
    await waitForState(server, 'connected');

    const second = await connect();
    await second.nextLine();
    second.hello({ gameStartedAt: 99 });
    // The state should re-announce connected with the new session identity.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const s = server.getState();
      if (s.kind === 'connected' && s.gameStartedAt === 99) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const state = server.getState();
    assert.ok(state.kind === 'connected' && state.gameStartedAt === 99);
  });
});
