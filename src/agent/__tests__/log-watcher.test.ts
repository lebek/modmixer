import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatErrorSummary,
  mergeGroups,
  parseErrorBlocks,
} from '../log-watcher.js';

/**
 * Fixtures are lifted from real RimWorld Player.log content so the parser is
 * tested against the actual output shape, not an idealization. See
 * Player-prev.log on a developer machine for ground truth.
 */

describe('parseErrorBlocks', () => {
  it('groups a [Ref]-tagged exception with its stack trace', () => {
    const log = [
      'Sending standard incident letter with no label or text.',
      'Exception filling window for LudeonTK.Dialog_DevPalette: System.NullReferenceException: Object reference not set to an instance of an object',
      '[Ref AA2B8458]',
      '  at Verse.LetterMaker.MakeLetter (Verse.TaggedString label) [0x00000] in <hash>:0 ',
      '  at RimWorld.IncidentWorker.SendStandardLetter () [0x00000] in <hash>:0 ',
    ].join('\n');
    const groups = parseErrorBlocks(log);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].key, 'ref:AA2B8458');
    assert.equal(groups[0].refLabel, '[Ref AA2B8458]');
    assert.equal(groups[0].drillPattern, '[Ref AA2B8458]');
    assert.equal(groups[0].hasStackTrace, true);
    assert.match(groups[0].message, /Sending standard incident letter/);
    assert.match(groups[0].message, /NullReferenceException/);
  });

  it('treats "Duplicate stacktrace" recurrences as the same ref group', () => {
    // Two cascade entries for the same stack — RimWorld dedups the trace
    // itself; our grouping should fold them into one entry with count=2.
    const log = [
      'Error while determining if Zombie21664 should have Need Chemical_Alcohol: System.ArgumentOutOfRangeException: Index out of range.',
      'Parameter name: index',
      '[Ref 597E0343]',
      '  at System.Collections.Generic.List`1[T].get_Item () [0x00000] in <hash>:0 ',
      '',
      'Error while determining if Zombie21664 should have Need Chemical_Ambrosia: System.ArgumentOutOfRangeException: Index out of range.',
      'Parameter name: index',
      '[Ref 597E0343] Duplicate stacktrace, see ref for original',
    ].join('\n');
    const groups = mergeGroups(parseErrorBlocks(log));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].key, 'ref:597E0343');
    assert.equal(groups[0].count, 2);
    assert.equal(groups[0].hasStackTrace, true);
    // First occurrence's message wins for display.
    assert.match(groups[0].message, /Chemical_Alcohol/);
  });

  it('groups a config error (no ref, no stack) by normalized message', () => {
    const log = [
      'Config error in ZombieFaction: raidLootValueFromPointsCurve must be defined',
      '',
      'Config error in ZombieSwarmer: PawnKindDef defines 1 lifeStages while race def defines 0',
    ].join('\n');
    const groups = parseErrorBlocks(log);
    assert.equal(groups.length, 2);
    for (const g of groups) {
      assert.equal(g.refLabel, '[no-ref]');
      assert.equal(g.hasStackTrace, false);
      assert.match(g.key, /^msg:/);
    }
    // The drill pattern should be a substring usable in tail_player_log.
    assert.equal(groups[0].drillPattern, 'Config error in ZombieFaction');
  });

  it('collapses per-instance variants via numeric normalization', () => {
    // Two config errors with varying integers — same normalized form.
    const log = [
      'Config error in Pawn_42: Stat 17 is invalid',
      '',
      'Config error in Pawn_99: Stat 23 is invalid',
    ].join('\n');
    const groups = mergeGroups(parseErrorBlocks(log));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 2);
  });

  it('detects a stack-frame-only block as a no-ref error', () => {
    // A Unity Debug.LogException path that bypasses Verse.Log's [Ref] tagging.
    const log = [
      'NullReferenceException: Object reference not set to an instance of an object',
      '  at MyMod.Patcher.Apply () [0x00000] in <hash>:0 ',
    ].join('\n');
    const groups = parseErrorBlocks(log);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].refLabel, '[no-ref]');
    assert.equal(groups[0].hasStackTrace, true);
  });

  it('drops noise blocks (PhysX, fallback library loads)', () => {
    const log = [
      'Fallback handler could not load library C:/.../foo.dll',
      '',
      '[PhysX] Initialized MultithreadedTaskDispatcher with 4 workers.',
      '',
      'Mono path[0] = "C:/RimWorld"',
      '',
      'Initialize engine version: 2022.3.35f1',
    ].join('\n');
    const groups = parseErrorBlocks(log);
    assert.equal(groups.length, 0);
  });

  it('keeps separate refs as separate groups', () => {
    const log = [
      'Exception A',
      '[Ref AA2B8458]',
      '  at Foo () [0x0] in <hash>:0 ',
      '',
      'Exception B',
      '[Ref BB123456]',
      '  at Bar () [0x0] in <hash>:0 ',
    ].join('\n');
    const groups = mergeGroups(parseErrorBlocks(log));
    assert.equal(groups.length, 2);
    const keys = new Set(groups.map((g) => g.key));
    assert.ok(keys.has('ref:AA2B8458'));
    assert.ok(keys.has('ref:BB123456'));
  });

  it('separates cascade entries that are NOT blank-line-separated', () => {
    // In real Player.log output, cascade errors are joined by single
    // newlines — there are no blank lines between consecutive error blocks.
    // Block-splitting on /\n\s*\n/ collapses them into one; the state
    // machine must walk them as separate events.
    const log = [
      'Error while determining if Zombie21664 should have Need Chemical_Alcohol: ArgumentOutOfRangeException',
      'Parameter name: index',
      '[Ref 597E0343]',
      '  at System.Collections.Generic.List`1[T].get_Item () [0x0] in <hash>:0 ',
      '  at Verse.Pawn_AgeTracker.RecalculateLifeStageIndex () [0x0] in <hash>:0 ',
      'Error while determining if Zombie21664 should have Need Chemical_Ambrosia: ArgumentOutOfRangeException',
      'Parameter name: index',
      '[Ref 597E0343] Duplicate stacktrace, see ref for original',
      'Error while determining if Zombie21664 should have Need Food: ArgumentOutOfRangeException',
      'Parameter name: index',
      '[Ref 597E0343] Duplicate stacktrace, see ref for original',
    ].join('\n');
    const groups = mergeGroups(parseErrorBlocks(log));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].key, 'ref:597E0343');
    assert.equal(groups[0].count, 3);
    assert.equal(groups[0].hasStackTrace, true);
  });

  it('handles the full cascade shape from the zombie horde session', () => {
    // Truncated reproduction of the actual prev-log content. Should resolve
    // to: 1× config error, 1× config error, 1× exception with [Ref], 1×
    // [Ref]-grouped cascade with multiple counts.
    const log = [
      'Config error in ZombieFaction: raidLootValueFromPointsCurve must be defined',
      '',
      'Config error in ZombieSwarmer: PawnKindDef defines 1 lifeStages while race def defines 0',
      '',
      'Sending standard incident letter with no label or text.',
      'Exception filling window for LudeonTK.Dialog_DevPalette: NullReferenceException: …',
      '[Ref AA2B8458]',
      '  at Verse.LetterMaker.MakeLetter () [0x0] in <hash>:0 ',
      '',
      'Error while determining if Zombie21664 should have Need Chemical_Alcohol: ArgumentOutOfRangeException',
      'Parameter name: index',
      '[Ref 597E0343]',
      '  at System.Collections.Generic.List`1[T].get_Item () [0x0] in <hash>:0 ',
      '',
      'Error while determining if Zombie21664 should have Need Food: ArgumentOutOfRangeException',
      'Parameter name: index',
      '[Ref 597E0343] Duplicate stacktrace, see ref for original',
      '',
      'Error while determining if Zombie21665 should have Need Rest: ArgumentOutOfRangeException',
      'Parameter name: index',
      '[Ref 597E0343] Duplicate stacktrace, see ref for original',
    ].join('\n');
    const groups = mergeGroups(parseErrorBlocks(log));
    assert.equal(groups.length, 4);
    const cascade = groups.find((g) => g.key === 'ref:597E0343')!;
    assert.equal(cascade.count, 3);
    const exception = groups.find((g) => g.key === 'ref:AA2B8458')!;
    assert.equal(exception.count, 1);
    const configs = groups.filter((g) => g.refLabel === '[no-ref]');
    assert.equal(configs.length, 2);
  });
});

describe('formatErrorSummary', () => {
  it('renders a deduped summary with counts and refs (drill-in guidance lives in the system prompt)', () => {
    const log = [
      'Exception filling window: NullReferenceException',
      '[Ref AA2B8458]',
      '  at Foo () [0x0] in <hash>:0 ',
      '',
      'Error while determining if Zombie21664 should have Need X: ArgumentOutOfRangeException',
      '[Ref 597E0343]',
      '  at Bar () [0x0] in <hash>:0 ',
      '',
      'Error while determining if Zombie21664 should have Need Y: ArgumentOutOfRangeException',
      '[Ref 597E0343] Duplicate stacktrace, see ref for original',
      '',
      'Config error in ZombieFaction: raidLootValueFromPointsCurve must be defined',
    ].join('\n');
    const groups = mergeGroups(parseErrorBlocks(log));
    const summary = formatErrorSummary(groups);
    assert.match(summary, /\[automated/);
    assert.match(summary, /4 errors \(3 unique\)/);
    // High-count item sorts first.
    const refIdx = summary.indexOf('[Ref 597E0343]');
    const exceptionIdx = summary.indexOf('[Ref AA2B8458]');
    assert.ok(refIdx >= 0 && exceptionIdx >= 0 && refIdx < exceptionIdx);
    // Drill-in instructions live in the system prompt now, not the summary.
    assert.doesNotMatch(summary, /tail_player_log/);
  });
});
