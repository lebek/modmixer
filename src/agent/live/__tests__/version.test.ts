import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareDottedVersions } from '../version.js';

describe('compareDottedVersions', () => {
  it('orders plain dotted versions', () => {
    assert.equal(compareDottedVersions('0.1.0', '0.2.0'), -1);
    assert.equal(compareDottedVersions('0.2.0', '0.1.0'), 1);
    assert.equal(compareDottedVersions('0.2.0', '0.2.0'), 0);
  });

  it('compares segments numerically, not lexically', () => {
    assert.equal(compareDottedVersions('0.10', '0.9'), 1);
    assert.equal(compareDottedVersions('1.0.10', '1.0.2'), 1);
  });

  it('treats missing segments as zero', () => {
    assert.equal(compareDottedVersions('1.5', '1.5.0'), 0);
    assert.equal(compareDottedVersions('1.5', '1.5.1'), -1);
  });

  it('treats garbage as older than any real version', () => {
    assert.equal(compareDottedVersions('', '0.0.1'), -1);
    assert.equal(compareDottedVersions('beta', '0.0.1'), -1);
    assert.equal(compareDottedVersions('', '0'), 0);
  });
});
