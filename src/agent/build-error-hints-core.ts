import type { SymbolMatch } from './index/resolve-symbol-core.js';

/**
 * Post-build hints derived from compile errors. Today we focus on the single
 * highest-leverage class of failure: missing `using` directives. The C#
 * compiler tells us *exactly* which symbol is unresolved (CS0246, CS0103,
 * CS1061) — we just look that symbol up in the indexed RimWorld source and
 * tell the agent which `using …;` line to add.
 *
 * This is post-build cosmetic help: we never block the build, never modify
 * source, and degrade gracefully (empty output) if the index isn't built or
 * the symbol isn't found.
 */

export interface BuildErrorHint {
  /** The CS code we matched, e.g. "CS1061". */
  code: string;
  /** Workspace-relative file path the error pointed at, when available. */
  file?: string;
  /** Line number from the diagnostic, when available. */
  line?: number;
  /** The unresolved symbol short name we extracted, e.g. "IsWorldPawn". */
  symbol: string;
  /** Resolved candidates from the symbol index. May be empty. */
  candidates: SymbolMatch[];
}

export interface ParsedDiagnostic {
  file?: string;
  line?: number;
  code: string;
  message: string;
}

/** Match the leading `path/to/file.cs(line,col): error CSXXXX: …` portion. */
const DIAG_RE =
  /^(?:(.+?)\((\d+),\d+\):\s+)?error\s+(CS\d+):\s+(.*?)(?:\s+\[[^\]]+\])?\s*$/;

/**
 * Capture the symbol referenced by each compiler error code we know how to
 * handle. The index lookups happen later — this just turns text into
 * (code, symbol) pairs.
 */
export const SYMBOL_EXTRACTORS: Array<{
  code: string;
  /** Returns the unresolved short name(s) for this message, or null. */
  extract: (message: string) => string[] | null;
}> = [
  {
    // "The type or namespace name 'Foo' could not be found"
    code: 'CS0246',
    extract: (m) => {
      const r =
        /(?:type or namespace name|namespace name)\s+'([^']+)'\s+(?:could not be found|does not exist)/.exec(
          m,
        );
      return r ? [stripGenericArity(r[1])] : null;
    },
  },
  {
    // "The name 'Foo' does not exist in the current context"
    code: 'CS0103',
    extract: (m) => {
      const r = /name\s+'([^']+)'\s+does not exist/.exec(m);
      return r ? [stripGenericArity(r[1])] : null;
    },
  },
  {
    // "'Pawn' does not contain a definition for 'IsWorldPawn' and no
    // accessible extension method 'IsWorldPawn' …"
    // Both names matter: the receiver (`Pawn`) is the type the user has, and
    // the second name is the missing extension method we need to import.
    code: 'CS1061',
    extract: (m) => {
      const ext =
        /accessible extension method\s+'([^']+)'/.exec(m) ??
        /does not contain a definition for\s+'([^']+)'/.exec(m);
      return ext ? [stripGenericArity(ext[1])] : null;
    },
  },
];

/**
 * For testing and reuse: given a CS code + message, return the unresolved
 * symbol short name(s) we'd look up, or null if we don't handle this code.
 */
export function extractSymbolFromMessage(
  code: string,
  message: string,
): string[] | null {
  const extractor = SYMBOL_EXTRACTORS.find((e) => e.code === code);
  return extractor ? extractor.extract(message) : null;
}

/** Some error messages quote `Foo<T>` as `Foo`; tree-sitter stores the bare
 * short name. Strip any `<…>` from the captured token before lookup. */
function stripGenericArity(name: string): string {
  const idx = name.indexOf('<');
  return idx >= 0 ? name.slice(0, idx) : name;
}

/**
 * Parse `dotnet build` stdout and return one diagnostic per `error CSxxxx`
 * line. Other lines (warnings, restore output, "Build FAILED" footer) are
 * skipped. dotnet sometimes emits the same diagnostic twice (once during the
 * compile, again in the failure summary) — we dedupe by file+line+code+symbol
 * later in `extractHints`.
 */
export function parseDiagnostics(stdout: string): ParsedDiagnostic[] {
  const out: ParsedDiagnostic[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = DIAG_RE.exec(line);
    if (!m) continue;
    const [, fileMaybe, lineMaybe, code, message] = m;
    out.push({
      file: fileMaybe || undefined,
      line: lineMaybe ? Number(lineMaybe) : undefined,
      code,
      message,
    });
  }
  return out;
}

/**
 * Render hints as a build-output footer. Empty string when nothing to say.
 *
 * The tone is "here's what the index thinks" — we never claim certainty, and
 * we always show the namespace so the agent can apply the fix without a
 * follow-up tool call.
 */
export function formatHints(hints: BuildErrorHint[]): string {
  if (hints.length === 0) return '';
  const lines: string[] = [
    '',
    `--- modmixer suggestions (${hints.length} ${
      hints.length === 1 ? 'hint' : 'hints'
    }) ---`,
  ];
  for (const h of hints) {
    const loc =
      h.file && h.line !== undefined
        ? ` ${h.file}(${h.line})`
        : h.file
        ? ` ${h.file}`
        : '';
    if (h.candidates.length === 1) {
      const c = h.candidates[0];
      const ext = c.isExtensionMethod ? ' (extension method)' : '';
      lines.push(
        `* ${h.code}${loc}: ${h.symbol} — try \`using ${c.namespace};\`${ext} (${c.kind} ${c.fqn})`,
      );
    } else {
      lines.push(
        `* ${h.code}${loc}: ${h.symbol} — multiple candidates:`,
      );
      for (const c of h.candidates) {
        const ext = c.isExtensionMethod ? ' (extension method)' : '';
        lines.push(
          `    - \`using ${c.namespace};\`${ext} for ${c.kind} ${c.fqn}`,
        );
      }
    }
  }
  lines.push(
    '',
    'Suggestions are derived from the indexed RimWorld source. Verify before applying — names can collide across mods or unrelated namespaces.',
    '',
  );
  return lines.join('\n');
}
