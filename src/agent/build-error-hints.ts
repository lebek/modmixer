import path from 'node:path';
import { resolveSymbol, type SymbolMatch } from './index/resolve-symbol.js';
import { getIndexStatus } from './index/rebuild.js';
import {
  parseDiagnostics,
  SYMBOL_EXTRACTORS,
  type BuildErrorHint,
} from './build-error-hints-core.js';

// Pure parse/format helpers live in ./build-error-hints-core.js and are
// re-exported here. extractHints stays because it reaches the symbol index
// (agent runtime + ESM-only deps); keeping the helpers separate lets their
// unit tests run without loading that graph.
export * from './build-error-hints-core.js';

/**
 * Produce hints for whatever the index can resolve. Public entry point used
 * by build_mod and resolve_symbol's tests.
 */
export function extractHints(
  buildStdout: string,
  modDir: string,
): BuildErrorHint[] {
  const status = getIndexStatus();
  if (status.type === 'absent' || status.type === 'no-rimworld') {
    // Index isn't available — no hints to give. Don't surface a fake "no
    // hints" line either; the build output is already busy enough.
    return [];
  }

  const diagnostics = parseDiagnostics(buildStdout);
  const seen = new Set<string>();
  const hints: BuildErrorHint[] = [];
  for (const d of diagnostics) {
    const extractor = SYMBOL_EXTRACTORS.find((e) => e.code === d.code);
    if (!extractor) continue;
    const symbols = extractor.extract(d.message);
    if (!symbols) continue;
    for (const sym of symbols) {
      const fileRel = d.file ? path.relative(modDir, d.file) : undefined;
      const dedupeKey = `${d.code}|${fileRel ?? ''}|${d.line ?? ''}|${sym}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      let candidates: SymbolMatch[];
      try {
        candidates = resolveSymbol(sym);
      } catch (err) {
        console.warn('[build-error-hints] resolveSymbol failed:', err);
        candidates = [];
      }
      // Drop candidates with no namespace — those don't tell the agent
      // anything actionable. Keep at most 5; if a name is genuinely
      // ambiguous the agent should switch to read_symbol.
      candidates = candidates
        .filter((c) => c.namespace !== null)
        .slice(0, 5);
      if (candidates.length === 0) continue;
      hints.push({
        code: d.code,
        file: fileRel,
        line: d.line,
        symbol: sym,
        candidates,
      });
    }
  }
  return hints;
}
