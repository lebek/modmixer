import type Database from 'better-sqlite3';

/**
 * Minimal row shape consumed by the enrichment logic. Mirrors the columns we
 * read from the `symbol` table — kept as a separate type so the pure
 * (DB-free) helpers below can be tested without touching better-sqlite3.
 */
export interface SymbolRow {
  fqn: string;
  shortName: string;
  kind: string;
  parentFqn: string | null;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string | null;
}

/**
 * Lookup hook used by `enrichSymbolRow` to walk the parent chain. Production
 * passes a function backed by SQLite; tests pass a Map-based stub. The hook
 * returns null for any FQN that isn't a recorded type symbol — that's how we
 * detect "we've crossed into namespace territory."
 */
export type ParentLookup = (
  fqn: string,
) => { kind: string; parentFqn: string | null } | null;

/**
 * One row from the symbol table, enriched with the namespace/type split that
 * callers actually need ("which `using` do I add?", "is this an extension
 * method?"). Derived from the existing `parentFqn` / `signature` columns —
 * we don't change the schema.
 */
export interface SymbolMatch {
  fqn: string;
  shortName: string;
  kind: string;
  /**
   * The namespace of the *enclosing top-level* type, or the symbol itself
   * for top-level types. Null for symbols defined in the global namespace.
   * This is the value that should appear in a `using …;` directive.
   */
  namespace: string | null;
  /**
   * The enclosing top-level type's FQN, e.g. `RimWorld.Planet.WorldPawnsUtility`
   * for `IsWorldPawn`. Null when the symbol *is* a top-level type or sits in
   * the global namespace.
   */
  enclosingType: string | null;
  /** Original parentFqn from the symbol table (namespace OR enclosing type). */
  parentFqn: string | null;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string | null;
  /**
   * True if `signature` declares the symbol as an extension method (a static
   * method whose first parameter is `this T self`). The diagnostic for
   * extension-method-not-found (CS1061) is the highest-leverage case for this
   * resolver — that's why we surface it explicitly rather than making callers
   * re-parse the signature.
   */
  isExtensionMethod: boolean;
}

const TYPE_KINDS = new Set([
  'class',
  'struct',
  'interface',
  'enum',
  'record',
  'delegate',
]);

/**
 * Variant that takes an explicit DB. Used by tests (which build an in-memory
 * DB) and by future callers that want to share a transaction.
 */
export function resolveSymbolFromDb(
  db: Database.Database,
  shortName: string,
  options: { kind?: string; limit?: number } = {},
): SymbolMatch[] {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);

  const where = ['shortName = @shortName'];
  const args: Record<string, unknown> = { shortName };
  if (options.kind) {
    where.push('kind = @kind');
    args.kind = options.kind;
  }
  const sql = `
    SELECT fqn, shortName, kind, parentFqn, filePath, startLine, endLine, signature
    FROM symbol
    WHERE ${where.join(' AND ')}
    ORDER BY length(fqn), fqn
    LIMIT ${limit}
  `;
  const rows = db.prepare(sql).all(args) as Array<{
    fqn: string;
    shortName: string;
    kind: string;
    parentFqn: string | null;
    filePath: string;
    startLine: number;
    endLine: number;
    signature: string | null;
  }>;

  // Look up the type chain once per distinct parentFqn — many members share
  // an enclosing type, and chasing nested types means re-querying.
  const enclosingCache = new Map<string, EnclosingResolution>();

  // The DB-aware lookup. `enrichSymbolRow` doesn't know about better-sqlite3
  // directly; we keep the SQL query right here so the pure helper stays
  // pure.
  const parentStmt = db.prepare(
    'SELECT kind, parentFqn FROM symbol WHERE fqn = @fqn LIMIT 1',
  );
  const lookup: ParentLookup = (fqn) =>
    (parentStmt.get({ fqn }) as
      | { kind: string; parentFqn: string | null }
      | undefined) ?? null;
  return rows.map((r) => enrichSymbolRow(r, lookup, enclosingCache));
}

export interface EnclosingResolution {
  enclosingType: string | null;
  namespace: string | null;
}

/**
 * Pure enrichment: row → SymbolMatch given a parent lookup. Exported so
 * tests can drive it with a Map-based lookup instead of standing up a DB.
 *
 * The cache is keyed by the symbol's own FQN and stores the resolved
 * enclosing-type / namespace pair. Pass a fresh Map per call if you don't
 * want sharing.
 */
export function enrichSymbolRow(
  row: SymbolRow,
  lookupParent: ParentLookup,
  cache: Map<string, EnclosingResolution> = new Map(),
): SymbolMatch {
  let enclosingType: string | null;
  let namespace: string | null;

  if (TYPE_KINDS.has(row.kind)) {
    // The symbol is itself a type. If parentFqn is also a type (nested
    // class), walk up to the outer enclosing type. The namespace is the
    // first non-type ancestor.
    const resolved = resolveTypeAncestry(
      row.fqn,
      row.parentFqn,
      lookupParent,
      cache,
    );
    enclosingType = resolved.enclosingType ?? row.fqn;
    namespace = resolved.namespace;
    // Top-level type case: enclosingType is the symbol itself, but for the
    // "where do I import this from" answer we want the namespace, not the
    // type. Keep enclosingType pointing at the symbol; the namespace field
    // is what callers should put in `using …;`.
    if (resolved.enclosingType === null) {
      enclosingType = null; // top-level type — no enclosing type
    }
  } else {
    // Member symbol — parentFqn is necessarily a type (or null in the
    // pathological case of a top-level method, which C# doesn't allow but
    // tree-sitter could emit).
    const resolved = resolveTypeAncestry(
      row.parentFqn ?? '',
      row.parentFqn,
      lookupParent,
      cache,
    );
    enclosingType = resolved.enclosingType ?? row.parentFqn;
    namespace = resolved.namespace;
  }

  return {
    fqn: row.fqn,
    shortName: row.shortName,
    kind: row.kind,
    namespace,
    enclosingType,
    parentFqn: row.parentFqn,
    filePath: row.filePath,
    startLine: row.startLine,
    endLine: row.endLine,
    signature: row.signature,
    isExtensionMethod: detectExtensionMethod(row.kind, row.signature),
  };
}

/**
 * Walk parentFqn upward through the symbol table. Each ancestor that exists
 * as a type symbol is "still inside a type"; the first ancestor that is NOT
 * a type symbol is the namespace.
 *
 * `selfFqn` is the FQN we started from — used so the cache key is stable.
 * `startParent` is the parentFqn of that symbol.
 */
function resolveTypeAncestry(
  selfFqn: string,
  startParent: string | null,
  lookupParent: ParentLookup,
  cache: Map<string, EnclosingResolution>,
): EnclosingResolution {
  const cached = cache.get(selfFqn);
  if (cached !== undefined) return cached;

  let outerType: string | null = null;
  let cursor = startParent;
  // We're walking up; record the deepest type we see — that's the enclosing
  // top-level type. The first ancestor that isn't a type row gives us the
  // namespace.
  while (cursor) {
    const parentRow = lookupParent(cursor);
    if (!parentRow) {
      // No symbol row at this FQN → it's a namespace. We're done.
      const resolution: EnclosingResolution = {
        enclosingType: outerType,
        namespace: cursor || null,
      };
      cache.set(selfFqn, resolution);
      return resolution;
    }
    if (TYPE_KINDS.has(parentRow.kind)) {
      // This ancestor is a type — keep walking, but remember it as a candidate
      // for the enclosing top-level type (overwritten on the next iteration
      // unless this is the outermost).
      outerType = cursor;
      cursor = parentRow.parentFqn;
      continue;
    }
    // Ancestor exists but isn't a type kind. That shouldn't happen with the
    // current indexer, but treat it as a namespace boundary defensively.
    const resolution: EnclosingResolution = {
      enclosingType: outerType,
      namespace: cursor,
    };
    cache.set(selfFqn, resolution);
    return resolution;
  }
  // cursor went null without us hitting a non-type ancestor → global namespace.
  const resolution: EnclosingResolution = {
    enclosingType: outerType,
    namespace: null,
  };
  cache.set(selfFqn, resolution);
  return resolution;
}

/**
 * Quick check: is this a `static` method whose first parameter is `this T x`?
 * The signature column stores the first line of the declaration, e.g.
 * `public static bool IsWorldPawn(this Pawn p)`. A loose regex is enough —
 * false positives are rare and harmless (the agent gets one extra hint about
 * usage, not a wrong namespace).
 */
function detectExtensionMethod(kind: string, signature: string | null): boolean {
  if (kind !== 'method' || !signature) return false;
  if (!/\bstatic\b/.test(signature)) return false;
  // Match `(this Type ...` or `(this in Type ...` / `(this ref Type ...`.
  return /\(\s*this\s+(?:in\s+|ref\s+|out\s+)?[\w<>.,\s[\]]+/.test(signature);
}
