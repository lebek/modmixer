import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  enrichSymbolRow,
  type ParentLookup,
  type SymbolRow,
} from '../index/resolve-symbol-core.js';

/**
 * The resolver tests exercise the pure enrichment helper. We can't load the
 * real SQLite-backed `resolveSymbolFromDb` from a plain `node --test`
 * invocation because better-sqlite3 in this repo is built against Electron's
 * NODE_MODULE_VERSION, not Node's. Driving `enrichSymbolRow` with a
 * Map-backed lookup covers the same logic — namespace walking, extension
 * detection, nested-type collapse — minus the SQL plumbing.
 */
function makeLookup(rows: SymbolRow[]): ParentLookup {
  const byFqn = new Map<string, SymbolRow>();
  for (const r of rows) byFqn.set(r.fqn, r);
  return (fqn) => {
    const r = byFqn.get(fqn);
    return r ? { kind: r.kind, parentFqn: r.parentFqn } : null;
  };
}

function row(partial: Partial<SymbolRow> & Pick<SymbolRow, 'fqn' | 'shortName' | 'kind' | 'parentFqn'>): SymbolRow {
  return {
    filePath: `mock/${partial.fqn.replace(/\./g, '/')}.cs`,
    startLine: 1,
    endLine: 10,
    signature: null,
    ...partial,
  };
}

describe('enrichSymbolRow', () => {
  it('returns the correct namespace for an extension method', () => {
    // Mirrors the actual RimWorld layout that bit the agent: IsWorldPawn is
    // declared on WorldPawnsUtility in the RimWorld.Planet namespace.
    const utility = row({
      fqn: 'RimWorld.Planet.WorldPawnsUtility',
      shortName: 'WorldPawnsUtility',
      kind: 'class',
      parentFqn: 'RimWorld.Planet',
    });
    const isWorldPawn = row({
      fqn: 'RimWorld.Planet.WorldPawnsUtility.IsWorldPawn',
      shortName: 'IsWorldPawn',
      kind: 'method',
      parentFqn: 'RimWorld.Planet.WorldPawnsUtility',
      signature: 'public static bool IsWorldPawn(this Pawn p)',
    });
    const lookup = makeLookup([utility, isWorldPawn]);
    const m = enrichSymbolRow(isWorldPawn, lookup);
    assert.equal(m.namespace, 'RimWorld.Planet');
    assert.equal(m.enclosingType, 'RimWorld.Planet.WorldPawnsUtility');
    assert.equal(m.isExtensionMethod, true);
    assert.equal(m.kind, 'method');
  });

  it('returns the namespace itself for a top-level type', () => {
    const wt = row({
      fqn: 'RimWorld.WorkTypeDef',
      shortName: 'WorkTypeDef',
      kind: 'class',
      parentFqn: 'RimWorld',
    });
    const m = enrichSymbolRow(wt, makeLookup([wt]));
    assert.equal(m.namespace, 'RimWorld');
    // Top-level type: enclosingType should be null (not the symbol itself).
    assert.equal(m.enclosingType, null);
  });

  it('walks nested types up to the namespace boundary', () => {
    // Outer.Inner.method — the namespace is whatever Outer lives in.
    const outer = row({
      fqn: 'Foo.Bar.Outer',
      shortName: 'Outer',
      kind: 'class',
      parentFqn: 'Foo.Bar',
    });
    const inner = row({
      fqn: 'Foo.Bar.Outer.Inner',
      shortName: 'Inner',
      kind: 'class',
      parentFqn: 'Foo.Bar.Outer',
    });
    const doStuff = row({
      fqn: 'Foo.Bar.Outer.Inner.DoStuff',
      shortName: 'DoStuff',
      kind: 'method',
      parentFqn: 'Foo.Bar.Outer.Inner',
      signature: 'public void DoStuff()',
    });
    const lookup = makeLookup([outer, inner, doStuff]);
    const m = enrichSymbolRow(doStuff, lookup);
    assert.equal(m.namespace, 'Foo.Bar');
    // Enclosing type should be the *outer* type, not the immediate parent.
    assert.equal(m.enclosingType, 'Foo.Bar.Outer');
  });

  it('does not flag non-static methods as extensions', () => {
    const r = row({
      fqn: 'NS.Foo.Bar',
      shortName: 'Bar',
      kind: 'method',
      parentFqn: 'NS.Foo',
      signature: 'public bool Bar(this Pawn p)', // missing `static`
    });
    const ns = row({
      fqn: 'NS.Foo',
      shortName: 'Foo',
      kind: 'class',
      parentFqn: 'NS',
    });
    const m = enrichSymbolRow(r, makeLookup([ns, r]));
    assert.equal(m.isExtensionMethod, false);
  });

  it('does not flag a static helper without `this` as an extension', () => {
    const r = row({
      fqn: 'NS.Helpers.Compute',
      shortName: 'Compute',
      kind: 'method',
      parentFqn: 'NS.Helpers',
      signature: 'public static int Compute(int x, int y)',
    });
    const cls = row({
      fqn: 'NS.Helpers',
      shortName: 'Helpers',
      kind: 'class',
      parentFqn: 'NS',
    });
    const m = enrichSymbolRow(r, makeLookup([cls, r]));
    assert.equal(m.isExtensionMethod, false);
  });

  it('handles `this in T` and `this ref T` extension forms', () => {
    const xCls = row({
      fqn: 'NS.X',
      shortName: 'X',
      kind: 'class',
      parentFqn: 'NS',
    });
    const mul = row({
      fqn: 'NS.X.Mul',
      shortName: 'Mul',
      kind: 'method',
      parentFqn: 'NS.X',
      signature: 'public static Vector3 Mul(this in Vector3 v, float s)',
    });
    const inc = row({
      fqn: 'NS.X.Inc',
      shortName: 'Inc',
      kind: 'method',
      parentFqn: 'NS.X',
      signature: 'public static void Inc(this ref Counter c)',
    });
    const lookup = makeLookup([xCls, mul, inc]);
    assert.equal(enrichSymbolRow(mul, lookup).isExtensionMethod, true);
    assert.equal(enrichSymbolRow(inc, lookup).isExtensionMethod, true);
  });

  it('caches across calls (same parent walked once)', () => {
    // Sharing a cache across many members of the same enclosing type is the
    // common path. Verify both the result and that the lookup is short-
    // circuited on the second call.
    const cls = row({
      fqn: 'A.B.C',
      shortName: 'C',
      kind: 'class',
      parentFqn: 'A.B',
    });
    const m1 = row({
      fqn: 'A.B.C.M1',
      shortName: 'M1',
      kind: 'method',
      parentFqn: 'A.B.C',
      signature: 'public void M1()',
    });
    const m2 = row({
      fqn: 'A.B.C.M2',
      shortName: 'M2',
      kind: 'method',
      parentFqn: 'A.B.C',
      signature: 'public void M2()',
    });
    let lookups = 0;
    const baseLookup = makeLookup([cls, m1, m2]);
    const counted: ParentLookup = (fqn) => {
      lookups++;
      return baseLookup(fqn);
    };
    const cache = new Map();
    enrichSymbolRow(m1, counted, cache);
    const after1 = lookups;
    enrichSymbolRow(m2, counted, cache);
    // Second enrichment on the same parent chain must not re-walk it.
    assert.equal(lookups, after1, 'cache should suppress repeat walks');
  });
});
