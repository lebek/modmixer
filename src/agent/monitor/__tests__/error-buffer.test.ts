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
 * MonitorServer is an EventEmitter, but ErrorBuffer only uses .on/.off; a
 * bare EventEmitter cast is enough for unit tests without standing up a
 * real TCP server.
 */
function makeFakeServer(): EventEmitter {
  return new EventEmitter();
}

/**
 * Hook a buffer + capture every flush into an array. Returned `flushes`
 * grows over time; `last()` returns the most recent flush (asserts there is
 * one) to dodge TypeScript's control-flow narrowing on a `let X | null`
 * captured in a callback.
 */
function captureFlushes(buf: ErrorBuffer): {
  flushes: ErrorBufferGroup[][];
  last: () => ErrorBufferGroup[];
} {
  const flushes: ErrorBufferGroup[][] = [];
  buf.subscribe((groups) => {
    flushes.push(groups);
  });
  return {
    flushes,
    last: () => {
      assert.ok(flushes.length > 0, 'expected at least one flush');
      return flushes[flushes.length - 1];
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
});

describe('formatErrorSummary', () => {
  it('renders the deduped summary with severity, attribution, and hash tag', () => {
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
    const summary = formatErrorSummary([groups[1], groups[0]]);
    assert.match(summary, /\[automated/);
    assert.match(summary, /23 events \(2 unique\)/);
    assert.match(summary, /\[#b2\]/);
    assert.match(summary, /\[#a1\]/);
    assert.match(summary, /\[RimWorld\]/);
    assert.match(summary, /\[Zombie Horde\]/);
    // Highest count appears first in the rendered output.
    const b2Idx = summary.indexOf('[#b2]');
    const a1Idx = summary.indexOf('[#a1]');
    assert.ok(b2Idx >= 0 && a1Idx >= 0 && b2Idx < a1Idx);
  });

  it('uses singular "event" when total is 1', () => {
    const summary = formatErrorSummary([makeGroup({ count: 1, hash: 'x' })]);
    assert.match(summary, /1 event\b/);
  });

  it('omits the unique-clause when each group occurred exactly once', () => {
    const summary = formatErrorSummary([
      makeGroup({ hash: 'a', count: 1 }),
      makeGroup({ hash: 'b', count: 1 }),
    ]);
    assert.match(summary, /2 events during/);
    assert.doesNotMatch(summary, /unique/);
  });
});
