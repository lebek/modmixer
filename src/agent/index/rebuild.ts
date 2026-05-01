import fs from 'node:fs';
import { detectRimWorldPaths } from '../paths.js';
import { closeIndexDb, openIndexDb, resetSchema } from './db.js';
import { decompileAssemblies } from './decompile.js';
import { indexDefs } from './defs-indexer.js';
import { indexCsharp } from './csharp-indexer.js';
import {
  detectFingerprint,
  fingerprintMatches,
  INDEX_SCHEMA_VERSION,
  readMeta,
  writeMeta,
  type IndexMeta,
} from './meta.js';
import { getIndexPaths } from './paths.js';
import type {
  IndexProgressEvent,
  IndexProgressListener,
} from './progress.js';

export type IndexStatus =
  | { type: 'absent' }
  | { type: 'fresh'; meta: IndexMeta }
  | { type: 'stale'; meta: IndexMeta; reason: string }
  | { type: 'no-rimworld' }
  | { type: 'building'; phase: IndexProgressEvent };

export interface RebuildOptions {
  /** Force a full rebuild even if the cache matches. */
  force?: boolean;
  /** Whether to also index the user's enabled mod defs. */
  includeMods?: boolean;
  /** Cancel a long-running rebuild. */
  signal?: AbortSignal;
}

let activeAbort: AbortController | null = null;

/**
 * Public status check used by the main process at startup and by Settings.
 * Cheap — reads meta.json + a fingerprint snapshot.
 */
export function getIndexStatus(): IndexStatus {
  const rim = detectRimWorldPaths();
  if (!rim.managedDir) return { type: 'no-rimworld' };
  const meta = readMeta();
  if (!meta) return { type: 'absent' };
  const fp = detectFingerprint(meta.modFingerprints);
  if (!fp) return { type: 'no-rimworld' };
  if (!fingerprintMatches(meta, fp)) {
    let reason = 'install changed';
    if (meta.schemaVersion !== fp.schemaVersion) reason = 'modmixer index schema changed';
    else if (meta.rimworldVersion !== fp.rimworldVersion)
      reason = `RimWorld updated to ${fp.rimworldVersion}`;
    else if (meta.dlcs.join(',') !== fp.dlcs.join(','))
      reason = 'DLC set changed';
    return { type: 'stale', meta, reason };
  }
  // A meta whose counts are zero is the signature of a previous build that
  // ran against the wrong dataDir or with ilspycmd missing — RimWorld always
  // has Core defs and an Assembly-CSharp.dll, so non-zero counts are an
  // invariant of a real index. Treat the empty case as stale so startup
  // re-runs the pipeline instead of trusting the broken cache.
  if (meta.defCount === 0 || meta.symbolCount === 0) {
    return { type: 'stale', meta, reason: 'previous build produced an empty index' };
  }
  return { type: 'fresh', meta };
}

/** True iff a build is currently in progress. */
export function isRebuilding(): boolean {
  return activeAbort !== null;
}

/** Cancel an in-flight rebuild, if any. Idempotent. */
export function cancelRebuild(): void {
  if (activeAbort) {
    activeAbort.abort();
  }
}

/**
 * Run the full pipeline: defs → decompile → C# symbols → write meta. Emits
 * progress over `onProgress`. Throws on missing RimWorld install or
 * unrecoverable indexer errors. Concurrent calls are rejected — index
 * rebuilds are user-driven (startup or settings button) and only one runs
 * at a time.
 */
export async function rebuildIndex(
  onProgress: IndexProgressListener,
  options: RebuildOptions = {},
): Promise<IndexMeta> {
  if (activeAbort) {
    throw new Error('Index rebuild already in progress');
  }
  const ctrl = new AbortController();
  activeAbort = ctrl;
  options.signal?.addEventListener('abort', () => ctrl.abort());

  const start = Date.now();
  try {
    const rim = detectRimWorldPaths();
    if (!rim.managedDir) {
      throw new Error('RimWorld install not found — cannot build index.');
    }
    if (!rim.dataDir) {
      throw new Error(
        `RimWorld DLC packs not found near ${rim.managedDir} — cannot build index.`,
      );
    }
    const dataDir = rim.dataDir;
    const fp = detectFingerprint(/* modFingerprints */ []);
    if (!fp) throw new Error('RimWorld install not found.');

    onProgress({
      type: 'starting',
      phases: ['defs', 'decompile', 'symbols'],
    });

    const paths = getIndexPaths();
    fs.mkdirSync(paths.root, { recursive: true });

    // Reset DB before populating. Closing first so WAL files don't survive.
    closeIndexDb();
    const db = openIndexDb();
    resetSchema(db);

    // Phase 1: defs.
    onProgress({ type: 'phase', phase: 'defs', message: 'Indexing defs…' });
    const defCount = await indexDefs(
      db,
      {
        dataDir,
        dlcs: fp.dlcs,
        defsIndexRoot: paths.defsRoot,
        // includeMods is intentionally not wired through to scanning yet —
        // the caller will pass mod fingerprints in a future patch. For now
        // the toggle just persists in settings without changing the index.
      },
      onProgress,
    );

    // Phase 2: decompile.
    onProgress({
      type: 'phase',
      phase: 'decompile',
      message: 'Decompiling RimWorld assemblies (one-time, ~30-90s)…',
    });
    await decompileAssemblies(
      { managedDir: rim.managedDir, sourceRoot: paths.sourceRoot },
      onProgress,
      ctrl.signal,
    );

    // Phase 3: C# symbols.
    onProgress({
      type: 'phase',
      phase: 'symbols',
      message: 'Indexing C# symbols…',
    });
    const csharpRes = await indexCsharp(
      db,
      { sourceRoot: paths.sourceRoot },
      onProgress,
      ctrl.signal,
    );
    const { symbolCount, defReferenceCount, sourceBytes } = csharpRes;

    const meta: IndexMeta = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      rimworldVersion: fp.rimworldVersion,
      dlcs: fp.dlcs,
      modFingerprints: fp.modFingerprints,
      builtAt: new Date().toISOString(),
      defCount,
      symbolCount,
      sourceBytes,
    };
    writeMeta(meta);
    void defReferenceCount; // currently unused outside indexCsharp; kept for future telemetry

    onProgress({ type: 'done', durationMs: Date.now() - start });
    return meta;
  } catch (err) {
    onProgress({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    activeAbort = null;
  }
}

/**
 * Fire-and-forget startup helper: no-op when the index is fresh, otherwise
 * trigger a rebuild and stream progress through `onProgress`. Used by main.ts
 * during app startup so the agent host doesn't accept tool calls until the
 * index is at least usable.
 */
export async function ensureIndexFresh(
  onProgress: IndexProgressListener,
): Promise<IndexStatus> {
  const status = getIndexStatus();
  if (status.type === 'fresh') return status;
  if (status.type === 'no-rimworld') return status;
  await rebuildIndex(onProgress);
  return getIndexStatus();
}
