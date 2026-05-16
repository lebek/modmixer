import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  ErrorBuffer,
  formatErrorSummary,
  shouldSurface,
  type ErrorBufferGroup,
} from '../error-buffer.js';
import type { ErrorEvent } from '../protocol.js';

function makeEvent(overrides: Partial<ErrorEvent>): ErrorEvent {
  return {
    type: 'error_event',
    severity: 'error',
    firstLine: 'Some message',
    text: 'Some message\n  at Foo () [0x0] in <hash>:0',
    attributedMods: ['RimWorld'],
    hash: 'abc123',
    at: 1_700_000_000_000,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<ErrorBufferGroup>): ErrorBufferGroup {
  return {
    hash: 'abc123',
    severity: 'error',
    firstLine: 'Some message',
    attributedMods: ['RimWorld'],
    count: 1,
    firstAt: 1_700_000_000_000,
    lastAt: 1_700_000_000_000,
    ...overrides,
  };
}

/**
 * MonitorServer is an EventEmitter that also exposes getRunId(); ErrorBuffer
 * uses .on/.off plus that one method. A bare EventEmitter with getRunId
 * bolted on is enough for unit tests without standing up a real TCP server.
 * A new run is simulated by emitting a 'run' event (what MonitorServer does
 * when a new game session connects).
 */
type FakeServer = EventEmitter & { getRunId: () => number };

function makeFakeServer(initialRunId = 0): FakeServer {
  const ee = new EventEmitter() as FakeServer;
  ee.getRunId = () => initialRunId;
  return ee;
}

/**
 * Hook a buffer + capture every flush. `last()` returns the most recent
 * flush's groups; `lastRunId()` the run id it was tagged with.
 */
function captureFlushes(buf: ErrorBuffer): {
  flushes: ErrorBufferGroup[][];
  last: () => ErrorBufferGroup[];
  lastRunId: () => number;
} {
  const flushes: ErrorBufferGroup[][] = [];
  const runIds: number[] = [];
  buf.subscribe((groups, runId) => {
    flushes.push(groups);
    runIds.push(runId);
  });
  return {
    flushes,
    last: () => {
      assert.ok(flushes.length > 0, 'expected at least one flush');
      return flushes[flushes.length - 1];
    },
    lastRunId: () => {
      assert.ok(runIds.length > 0, 'expected at least one flush');
      return runIds[runIds.length - 1];
    },
  };
}

describe('ErrorBuffer ingest', () => {
  it('groups events by hash and counts dedupes', () => {
    const buf = new ErrorBuffer();
    const server = makeFakeServer();
    buf.attach(server as never, {});
    const cap = captureFlushes(buf);

    server.emit('message', makeEvent({ hash: 'h1' }));
    server.emit('message', makeEvent({ hash: 'h1', at: 1_700_000_000_001 }));
    server.emit('message', makeEvent({ hash: 'h2' }));

    buf.flushNow();
    const flushed = cap.last();
    assert.equal(flushed.length, 2);
    const h1 = flushed.find((g) => g.hash === 'h1');
    assert.ok(h1);
    assert.equal(h1.count, 2);
    assert.equal(h1.lastAt, 1_700_000_000_001);
  });

  it('ignores non error_event messages', () => {
    const buf = new ErrorBuffer();
    const server = makeFakeServer();
    buf.attach(server as never, {});
    const cap = captureFlushes(buf);

    server.emit('message', { type: 'perf', gameTick: 1 });
    server.emit('message', { type: 'mods_snapshot', mods: [] });
    buf.flushNow();
    assert.equal(cap.flushes.length, 0);
  });

  it('detach stops ingesting events', () => {
    const buf = new ErrorBuffer();
    const server = makeFakeServer();
    buf.attach(server as never, {});
    const cap = captureFlushes(buf);
    buf.detach();

    server.emit('message', makeEvent({ hash: 'h1' }));
    buf.flushNow();
    assert.equal(cap.flushes.length, 0);
  });

  it('sorts surfaced rows by count desc then firstAt asc', () => {
    const buf = new ErrorBuffer();
    const server = makeFakeServer();
    buf.attach(server as never, {});
    const cap = captureFlushes(buf);

    // h1: 1 occurrence at t=0.
    // h2: 3 occurrences starting at t=100. Should sort first (highest count).
    // h3: 1 occurrence at t=50. Should sort after h2, before h1 by time.
    server.emit('message', makeEvent({ hash: 'h1', at: 0 }));
    server.emit('message', makeEvent({ hash: 'h2', at: 100 }));
    server.emit('message', makeEvent({ hash: 'h2', at: 101 }));
    server.emit('message', makeEvent({ hash: 'h2', at: 102 }));
    server.emit('message', makeEvent({ hash: 'h3', at: 50 }));

    buf.flushNow();
    const flushed = cap.last();
    assert.equal(flushed.length, 3);
    assert.equal(flushed[0].hash, 'h2'); // count=3
    // h1 firstAt=0 < h3 firstAt=50 → h1 before h3.
    assert.equal(flushed[1].hash, 'h1');
    assert.equal(flushed[2].hash, 'h3');
  });
});

describe('ErrorBuffer edge-triggering (report once per run)', () => {
  it('surfaces an error class once, then stays silent on recurrence', () => {
    const buf = new ErrorBuffer();
    const server = makeFakeServer();
    buf.attach(server as never, {});
    const cap = captureFlushes(buf);

    server.emit('message', makeEvent({ hash: 'h1' }));
    buf.flushNow();
    assert.equal(cap.flushes.length, 1);
    assert.equal(cap.last()[0].hash, 'h1');

    // The same error keeps firing — must NOT re-prompt.
    server.emit('message', makeEvent({ hash: 'h1' }));
    server.emit('message', makeEvent({ hash: 'h1' }));
    buf.flushNow();
    assert.equal(cap.flushes.length, 1, 'recurrence must not re-flush');
  });

  it('still surfaces a class first seen after an earlier flush', () => {
    const buf = new ErrorBuffer();
    const server = makeFakeServer();
    buf.attach(server as never, {});
    const cap = captureFlushes(buf);

    server.emit('message', makeEvent({ hash: 'h1' }));
    buf.flushNow();
    server.emit('message', makeEvent({ hash: 'h2' }));
    buf.flushNow();

    assert.equal(cap.flushes.length, 2);
    assert.deepEqual(cap.flushes[0].map((g) => g.hash), ['h1']);
    assert.deepEqual(cap.flushes[1].map((g) => g.hash), ['h2']);
  });

  it('a new run clears the reported set so the same class surfaces again', () => {
    const buf = new ErrorBuffer();
    const server = makeFakeServer();
    buf.attach(server as never, {});
    const cap = captureFlushes(buf);

    server.emit('message', makeEvent({ hash: 'h1' }));
    buf.flushNow();
    assert.equal(cap.flushes.length, 1);

    // New game session → new run. The same stack signature is now a fresh
    // observation and must surface again.
    server.emit('run', 2);
    server.emit('message', makeEvent({ hash: 'h1' }));
    buf.flushNow();
    assert.equal(cap.flushes.length, 2);
    assert.equal(cap.last()[0].hash, 'h1');
  });

  it('a new run drops a pending un-flushed batch', () => {
    const buf = new ErrorBuffer();
    const server = makeFakeServer();
    buf.attach(server as never, {});
    const cap = captureFlushes(buf);

    server.emit('message', makeEvent({ hash: 'h1' }));
    // Game restarts before the batch flushed — pending h1 belongs to the
    // old run and must be discarded.
    server.emit('run', 2);
    buf.flushNow();
    assert.equal(cap.flushes.length, 0);
  });
});

describe('ErrorBuffer run id tagging', () => {
  it('tags the flush with the run id from a run event', () => {
    const buf = new ErrorBuffer();
    const server = makeFakeServer();
    buf.attach(server as never, {});
    const cap = captureFlushes(buf);

    server.emit('run', 5);
    server.emit('message', makeEvent({ hash: 'h1' }));
    buf.flushNow();
    assert.equal(cap.lastRunId(), 5);
  });

  it('seeds the run id from the server when a game is already connected', () => {
    const buf = new ErrorBuffer();
    const server = makeFakeServer(3); // bridge already up, run #3
    buf.attach(server as never, {});
    const cap = captureFlushes(buf);

    server.emit('message', makeEvent({ hash: 'h1' }));
    buf.flushNow();
    assert.equal(cap.lastRunId(), 3);
  });
});

describe('ErrorBuffer severity policy (shouldSurface)', () => {
  it('always surfaces error severity', () => {
    assert.equal(
      shouldSurface(
        makeGroup({ severity: 'error', count: 1, attributedMods: ['Other'] }),
        {},
      ),
      true,
    );
  });

  it('never surfaces message severity', () => {
    assert.equal(
      shouldSurface(makeGroup({ severity: 'message', count: 100 }), {}),
      false,
    );
  });

  it('surfaces warning when attributed to the mod under test (by name)', () => {
    assert.equal(
      shouldSurface(
        makeGroup({
          severity: 'warning',
          count: 1,
          attributedMods: ['Zombie Horde'],
        }),
        { modUnderTest: { name: 'Zombie Horde', packageId: 'lebek.zombiehorde' } },
      ),
      true,
    );
  });

  it('surfaces warning when attributed by packageId', () => {
    assert.equal(
      shouldSurface(
        makeGroup({
          severity: 'warning',
          count: 1,
          attributedMods: ['lebek.zombiehorde'],
        }),
        { modUnderTest: { name: 'Zombie Horde', packageId: 'lebek.zombiehorde' } },
      ),
      true,
    );
  });

  it('attribution match is case-insensitive', () => {
    assert.equal(
      shouldSurface(
        makeGroup({
          severity: 'warning',
          count: 1,
          attributedMods: ['ZOMBIE HORDE'],
        }),
        { modUnderTest: { name: 'Zombie Horde', packageId: 'lebek.zombiehorde' } },
      ),
      true,
    );
  });

  it('surfaces unrelated warning when count crosses the threshold', () => {
    // Below threshold → noise.
    assert.equal(
      shouldSurface(
        makeGroup({ severity: 'warning', count: 2, attributedMods: ['RimWorld'] }),
        { modUnderTest: { name: 'Zombie Horde', packageId: 'lebek.zombiehorde' } },
      ),
      false,
    );
    // At threshold → signal. The "Humanlike pawn ... was added to
    // non-humanlike faction" cascade the user originally reported was 20×;
    // 3 is the floor for "this is not a single-occurrence fluke."
    assert.equal(
      shouldSurface(
        makeGroup({ severity: 'warning', count: 3, attributedMods: ['RimWorld'] }),
        { modUnderTest: { name: 'Zombie Horde', packageId: 'lebek.zombiehorde' } },
      ),
      true,
    );
  });

  it('without modUnderTest, falls back to the count threshold', () => {
    assert.equal(
      shouldSurface(
        makeGroup({ severity: 'warning', count: 1, attributedMods: ['RimWorld'] }),
        {},
      ),
      false,
    );
    assert.equal(
      shouldSurface(
        makeGroup({ severity: 'warning', count: 3, attributedMods: ['RimWorld'] }),
        {},
      ),
      true,
    );
  });
});

describe('ErrorBuffer flush filtering', () => {
  it('drops info-level events and below-threshold unrelated warnings', () => {
    const buf = new ErrorBuffer();
    const server = makeFakeServer();
    buf.attach(server as never, {
      modUnderTest: { name: 'Zombie Horde', packageId: 'lebek.zombiehorde' },
    });
    const cap = captureFlushes(buf);

    server.emit('message', makeEvent({ hash: 'info1', severity: 'message' }));
    server.emit(
      'message',
      makeEvent({
        hash: 'warn-other-1',
        severity: 'warning',
        attributedMods: ['Some Other Mod'],
      }),
    );
    server.emit(
      'message',
      makeEvent({
        hash: 'warn-ours',
        severity: 'warning',
        attributedMods: ['Zombie Horde'],
      }),
    );
    server.emit('message', makeEvent({ hash: 'err1', severity: 'error' }));

    buf.flushNow();
    const flushed = cap.last();
    const hashes = flushed.map((g) => g.hash).sort();
    assert.deepEqual(hashes, ['err1', 'warn-ours']);
  });

  it('surfaces a vanilla-attributed warning cascade once it crosses the threshold', () => {
    const buf = new ErrorBuffer();
    const server = makeFakeServer();
    buf.attach(server as never, {
      modUnderTest: { name: 'Zombie Horde', packageId: 'lebek.zombiehorde' },
    });
    const cap = captureFlushes(buf);

    // Three identical-hash warnings attributed to vanilla — the user's
    // "Humanlike pawn was added to non-humanlike faction" pattern, post-fix
    // (stack-signature hashing collapses the 20 per-pawn variants to one
    // hash). Should surface.
    for (let i = 0; i < 3; i++) {
      server.emit(
        'message',
        makeEvent({
          hash: 'humanlike-cascade',
          severity: 'warning',
          firstLine: `Humanlike pawn Grimes${i} was added to non-humanlike faction zombie horde`,
          attributedMods: ['RimWorld'],
          at: 1_700_000_000_000 + i,
        }),
      );
    }
    buf.flushNow();
    const flushed = cap.last();
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].hash, 'humanlike-cascade');
    assert.equal(flushed[0].count, 3);
  });

  it('a sub-threshold warning is not marked reported and can surface later', () => {
    const buf = new ErrorBuffer();
    const server = makeFakeServer();
    buf.attach(server as never, {});
    const cap = captureFlushes(buf);

    // One occurrence — below the count threshold, dropped, NOT reported.
    server.emit('message', makeEvent({ hash: 'w', severity: 'warning' }));
    buf.flushNow();
    assert.equal(cap.flushes.length, 0);

    // Now it cascades — must still be able to surface (wasn't suppressed).
    for (let i = 0; i < 3; i++) {
      server.emit('message', makeEvent({ hash: 'w', severity: 'warning' }));
    }
    buf.flushNow();
    assert.equal(cap.flushes.length, 1);
    assert.equal(cap.last()[0].hash, 'w');
  });
});

describe('formatErrorSummary', () => {
  it('renders the run-headed summary with severity, attribution, and hash tag', () => {
    const groups: ErrorBufferGroup[] = [
      makeGroup({
        hash: 'a1',
        severity: 'error',
        count: 3,
        attributedMods: ['Zombie Horde'],
        firstLine: 'Zombie21664 should have Need Chemical_Alcohol: ArgumentOutOfRangeException',
        firstAt: 0,
      }),
      makeGroup({
        hash: 'b2',
        severity: 'warning',
        count: 20,
        attributedMods: ['RimWorld'],
        firstLine: 'Humanlike pawn Grimes was added to non-humanlike faction zombie horde',
        firstAt: 1,
      }),
    ];
    // Caller passes groups already sorted by the buffer; format reflects
    // the order it was given.
    const summary = formatErrorSummary([groups[1], groups[0]], 4);
    assert.match(summary, /\[automated/);
    assert.match(summary, /test run #4/);
    assert.match(summary, /2 new error classes/);
    assert.match(summary, /\[#b2\]/);
    assert.match(summary, /\[#a1\]/);
    assert.match(summary, /\[RimWorld\]/);
    assert.match(summary, /\[Zombie Horde\]/);
    // Order is preserved from the caller's sort.
    const b2Idx = summary.indexOf('[#b2]');
    const a1Idx = summary.indexOf('[#a1]');
    assert.ok(b2Idx >= 0 && a1Idx >= 0 && b2Idx < a1Idx);
  });

  it('uses singular "class" when there is one new class', () => {
    const summary = formatErrorSummary([makeGroup({ count: 1, hash: 'x' })], 1);
    assert.match(summary, /1 new error class\b/);
    assert.doesNotMatch(summary, /classes/);
  });

  it('carries the run number it was given', () => {
    const summary = formatErrorSummary([makeGroup({ hash: 'x' })], 12);
    assert.match(summary, /test run #12/);
  });
});
