import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Api, Model } from '@earendil-works/pi-ai';
import {
  featuredModels,
  modelFamily,
  resolveDefaultModel,
} from '../model-selection.js';

/**
 * Only the fields the selection rules read. The real catalog entries carry
 * cost/context/thinking metadata we don't touch here.
 */
function model(provider: string, id: string): Model<Api> {
  return { provider, id, name: id } as unknown as Model<Api>;
}

function ids(models: readonly Model<Api>[]): string[] {
  return models.map((m) => m.id);
}

describe('modelFamily', () => {
  it('collapses a version token into a family key', () => {
    assert.equal(modelFamily('claude-opus-4-8').family, 'claude-opus-*');
    assert.equal(modelFamily('claude-opus-5').family, 'claude-opus-*');
    // GitHub Copilot spells the same models with dots.
    assert.equal(modelFamily('claude-opus-4.7').family, 'claude-opus-*');
  });

  it('keeps distinct suffixes in distinct families', () => {
    assert.equal(modelFamily('gpt-5.6-terra').family, 'gpt-*-terra');
    assert.equal(modelFamily('gpt-5.4-mini').family, 'gpt-*-mini');
    assert.equal(modelFamily('gpt-5.5').family, 'gpt-*');
  });

  it('treats an unversioned id as its own family', () => {
    assert.deepEqual(modelFamily('some-local-model'), {
      family: 'some-local-model',
      version: [0],
    });
  });
});

describe('featuredModels', () => {
  it('keeps only the newest model of each family', () => {
    // The Anthropic catalog as pi 0.82.1 ships it.
    const catalog = [
      'claude-fable-5',
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-1',
      'claude-opus-4-1-20250805',
      'claude-opus-4-5',
      'claude-opus-4-5-20251101',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-sonnet-4-5',
      'claude-sonnet-4-5-20250929',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
    ].map((id) => model('anthropic', id));

    assert.deepEqual(ids(featuredModels(catalog)), [
      'claude-fable-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
  });

  it('surfaces a new flagship with no code change', () => {
    // The point of the whole exercise: a model that lands in the catalog
    // after this build ships must reach the picker on its own.
    const catalog = ['claude-opus-5', 'claude-opus-6'].map((id) =>
      model('anthropic', id),
    );
    assert.deepEqual(ids(featuredModels(catalog)), ['claude-opus-6']);
  });

  it('drops dated aliases that duplicate a rolling id', () => {
    const catalog = ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'].map((id) =>
      model('anthropic', id),
    );
    assert.deepEqual(ids(featuredModels(catalog)), ['claude-haiku-4-5']);
  });

  it('drops non-chat modalities', () => {
    const catalog = [
      'gemini-3.1-pro-preview',
      'gemini-3.1-flash-lite-image',
      'gemini-3.1-flash-live-preview',
      'gemini-2.5-computer-use-preview-10-2025',
      'deep-research-max-preview-04-2026',
    ].map((id) => model('google', id));
    assert.deepEqual(ids(featuredModels(catalog)), ['gemini-3.1-pro-preview']);
  });

  it('orders newest first within a brand', () => {
    const catalog = ['gpt-5.4-mini', 'gpt-5.6-sol', 'gpt-5.5'].map((id) =>
      model('openai-codex', id),
    );
    assert.deepEqual(ids(featuredModels(catalog)), [
      'gpt-5.6-sol',
      'gpt-5.5',
      'gpt-5.4-mini',
    ]);
  });

  it('groups brands instead of interleaving unrelated version numbers', () => {
    // GitHub Copilot resells several vendors: Gemini 3.5 is not "older" than
    // GPT 5.4, so the list must not be sorted by raw version across brands.
    const catalog = [
      'gpt-5.4-nano',
      'gemini-3.5-flash',
      'claude-opus-5',
      'gpt-5.6-sol',
      'gemini-2.5-pro',
    ].map((id) => model('github-copilot', id));

    assert.deepEqual(ids(featuredModels(catalog)), [
      'claude-opus-5',
      'gemini-3.5-flash',
      'gemini-2.5-pro',
      'gpt-5.6-sol',
      'gpt-5.4-nano',
    ]);
  });
});

describe('resolveDefaultModel', () => {
  it('resolves a family key to the newest member', () => {
    const catalog = ['claude-opus-5', 'claude-sonnet-4-6', 'claude-sonnet-5'].map(
      (id) => model('anthropic', id),
    );
    assert.equal(
      resolveDefaultModel('anthropic', catalog)?.id,
      'claude-sonnet-5',
    );
  });

  it('ignores models from other providers', () => {
    const catalog = [
      model('github-copilot', 'claude-sonnet-5'),
      model('anthropic', 'claude-opus-5'),
    ];
    // anthropic has no sonnet in this catalog, so there is no default.
    assert.equal(resolveDefaultModel('anthropic', catalog), null);
  });

  it('returns null for a provider with no configured default', () => {
    assert.equal(
      resolveDefaultModel('local:whatever', [
        model('local:whatever', 'qwen3-coder'),
      ]),
      null,
    );
  });
});
