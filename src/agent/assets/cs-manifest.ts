import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { AssetKind } from './types.js';

/**
 * Per-mod sidecar that lists every asset path the mod's C# code loads via
 * `ContentFinder<T>.Get(...)`. Lives at `<mod>/.modmixer/cs-assets.json`.
 *
 * Why this file exists rather than scanning .cs source: ContentFinder calls
 * can carry consts, concatenations, method results, or anything else a
 * compiler resolves at link time. Regex-extracting the literal at the call
 * site only catches one shape and misses the idiomatic
 * `private const string FOO = "..."; Get(FOO);` pattern.
 *
 * The manifest is the agent's job to keep current. A drift-check pass in the
 * scanner sanity-checks the manifest against any string literals it sees
 * sitting inside Get(…) calls — both for "literal in code but missing from
 * manifest" and "manifest entry that doesn't appear anywhere".
 */
export const CS_MANIFEST_REL = '.modmixer/cs-assets.json';

export interface CsAssetManifest {
  textures: string[];
  audio: string[];
}

/**
 * One entry from the manifest, paired with its offset inside the JSON file
 * so the fork rewriter can edit the exact quoted string in-place when a
 * shared path needs to diverge.
 */
export interface CsManifestEntry {
  kind: AssetKind;
  stem: string;
  /** Byte offset of the opening quote of the path string in the JSON file. */
  tokenOffset: number;
  /** Length of the quoted string (including both quotes). */
  tokenLength: number;
}

export interface LoadedCsManifest {
  /** Empty entries[] when the file is absent or malformed — both are non-errors. */
  entries: CsManifestEntry[];
}

/**
 * Read and parse the C# asset manifest. Returns an empty result when the file
 * doesn't exist or fails to parse — the manifest is optional, so absence
 * means "no C# slots", not a hard error.
 */
export async function loadCsManifest(modDir: string): Promise<LoadedCsManifest> {
  const abs = path.join(modDir, CS_MANIFEST_REL);
  let raw: string;
  try {
    raw = await fsp.readFile(abs, 'utf8');
  } catch {
    return { entries: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { entries: [] };
  }
  if (!parsed || typeof parsed !== 'object') return { entries: [] };
  const obj = parsed as Partial<CsAssetManifest>;
  const entries: CsManifestEntry[] = [];
  collectKind(raw, obj.textures, 'texture', entries);
  collectKind(raw, obj.audio, 'audio', entries);
  return { entries };
}

function collectKind(
  raw: string,
  list: unknown,
  kind: AssetKind,
  out: CsManifestEntry[],
): void {
  if (!Array.isArray(list)) return;
  // Each path string is unique enough that we can locate it in the JSON via
  // indexOf — and we advance `cursor` so duplicate paths still get distinct
  // offsets (rare; the drift-check will flag them).
  let cursor = 0;
  for (const item of list) {
    if (typeof item !== 'string' || item.length === 0) continue;
    const stem = normalizeStem(item);
    const quoted = JSON.stringify(item);
    const at = raw.indexOf(quoted, cursor);
    if (at < 0) {
      // Couldn't relocate the literal — maybe the path uses JSON-escaped
      // characters our JSON.stringify doesn't reproduce identically. Fall
      // back to a synthetic offset; fork can't rewrite this entry safely
      // but the slot still appears.
      out.push({ kind, stem, tokenOffset: -1, tokenLength: 0 });
      continue;
    }
    out.push({ kind, stem, tokenOffset: at, tokenLength: quoted.length });
    cursor = at + quoted.length;
  }
}

function normalizeStem(stem: string): string {
  return stem.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.(png|ogg)$/i, '');
}

/**
 * Scan .cs files for `ContentFinder<T>.Get("literal")` calls and return the
 * literal stems we found, grouped by kind. Used only for the drift-check
 * against the manifest — not as a source of slots. Calls with non-literal
 * arguments (consts, concatenations) are intentionally ignored.
 */
export function extractCsLiterals(
  source: string,
): Array<{ kind: AssetKind; stem: string }> {
  const out: Array<{ kind: AssetKind; stem: string }> = [];
  const re =
    /\bContentFinder\s*<\s*(Texture2D|AudioClip)\s*>\s*\.\s*Get\s*\(\s*"([^"\r\n]+)"\s*[,)]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push({
      kind: m[1] === 'AudioClip' ? 'audio' : 'texture',
      stem: normalizeStem(m[2]),
    });
  }
  return out;
}

/**
 * Best-effort check: report literals that appear in .cs but aren't in the
 * manifest, and manifest entries that don't appear in any .cs literal. Both
 * sides of drift get separate warnings so the agent can read a scan and
 * know exactly what to fix.
 */
export function driftWarnings(
  manifest: LoadedCsManifest,
  literalsByFile: Array<{ sourceFile: string; literals: Array<{ kind: AssetKind; stem: string }> }>,
): string[] {
  const manifestSet = new Set(
    manifest.entries.map((e) => `${e.kind}::${e.stem}`),
  );
  const literalSet = new Set<string>();
  const warnings: string[] = [];

  for (const { sourceFile, literals } of literalsByFile) {
    for (const lit of literals) {
      const key = `${lit.kind}::${lit.stem}`;
      literalSet.add(key);
      if (!manifestSet.has(key)) {
        warnings.push(
          `${sourceFile}: ContentFinder<${lit.kind === 'audio' ? 'AudioClip' : 'Texture2D'}>.Get("${lit.stem}") — add "${lit.stem}" to ${CS_MANIFEST_REL} ${lit.kind === 'audio' ? 'audio' : 'textures'} list.`,
        );
      }
    }
  }

  // Manifest entries that nothing in .cs literally references. Could be
  // legitimate (path constructed at runtime, set via a const, etc.) — we
  // warn rather than error so the agent can audit.
  for (const entry of manifest.entries) {
    const key = `${entry.kind}::${entry.stem}`;
    if (!literalSet.has(key)) {
      warnings.push(
        `${CS_MANIFEST_REL}: "${entry.stem}" is declared but no string literal in .cs matches — confirm the path is loaded via const/method/etc., otherwise remove it.`,
      );
    }
  }

  return warnings;
}

/** Synchronous existence check — used to decide whether to surface drift warnings at all. */
export function csManifestExists(modDir: string): boolean {
  return fs.existsSync(path.join(modDir, CS_MANIFEST_REL));
}
