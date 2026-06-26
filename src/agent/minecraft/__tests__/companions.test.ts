import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { versionInRange } from '../companions.js';

describe('versionInRange (Maven-style NeoForge dependency ranges)', () => {
  it('admits a version inside a half-open range', () => {
    assert.equal(versionInRange('1.21.1', '[1.21,1.22)'), true);
    assert.equal(versionInRange('1.21.1', '[1.21.1,)'), true);
  });

  it('excludes a version below or above the range', () => {
    assert.equal(versionInRange('1.21.1', '[1.22,1.23)'), false);
    assert.equal(versionInRange('1.21.1', '[1.20,1.21)'), false); // upper exclusive
  });

  it('respects inclusive vs exclusive bounds at the boundary', () => {
    assert.equal(versionInRange('1.21.1', '[1.21.1,1.22]'), true);
    assert.equal(versionInRange('1.21.1', '(1.21.1,1.22)'), false); // lower exclusive
    assert.equal(versionInRange('1.21.1', '[1.20,1.21.1]'), true); // upper inclusive
  });

  it('handles NeoForge-style open-ended and exact ranges', () => {
    assert.equal(versionInRange('21.1.234', '[21.1.0,)'), true);
    assert.equal(versionInRange('21.0.5', '[21.1.0,)'), false);
    assert.equal(versionInRange('1.21.1', '[1.21.1]'), true);
    assert.equal(versionInRange('1.21.2', '[1.21.1]'), false);
  });

  it('admits when any interval in a set matches', () => {
    assert.equal(versionInRange('1.21.1', '[1.20,1.20.4],[1.21,1.22)'), true);
    assert.equal(versionInRange('1.20.6', '[1.20,1.20.4],[1.21,1.22)'), false);
  });

  it('returns null for a bare/soft version or empty range (never warns on those)', () => {
    assert.equal(versionInRange('1.21.1', '1.21.1'), null);
    assert.equal(versionInRange('1.21.1', ''), null);
  });
});
