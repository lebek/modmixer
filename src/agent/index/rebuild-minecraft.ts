import fs from 'node:fs';
import { getIndexPaths } from './paths.js';
import { closeIndexDb, openIndexDb, resetSchema } from './db.js';
import { indexJava } from './java-indexer.js';
import { ensureMinecraftSources, extractJar } from './minecraft-source.js';
import { ensureJdk21 } from '../minecraft/jdk.js';
import { toolchainFingerprint } from '../minecraft/versions.js';
import type { IndexProgressListener } from './progress.js';

/**
 * Minecraft index rebuild — the analogue of rebuild.ts (RimWorld). Pipeline:
 *   1. ensure a JDK 21 toolchain (auto-provisions Temurin if absent)
 *   2. generate decompiled mojmap+Parchment sources via createMinecraftArtifacts
 *   3. extract the sources jar into the per-game Source/ dir
 *   4. tree-sitter-java symbol index → the shared `symbol` table
 * Keyed to the pinned MC/NeoForge/Parchment toolchain so a version bump forces
 * a rebuild. Stored entirely under userData/index/minecraft/ (never shipped —
 * the sources are Mojang-licensed and generated locally).
 */

const MC_INDEX_SCHEMA_VERSION = 1;

export interface MinecraftIndexMeta {
  schemaVersion: number;
  /** Pinned toolchain fingerprint (MC + NeoForge + Parchment versions). */
  toolchain: string;
  symbolCount: number;
  sourceBytes: number;
  builtAt: string;
}

function readMcMeta(): MinecraftIndexMeta | null {
  const { metaPath } = getIndexPaths('minecraft');
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8')) as MinecraftIndexMeta;
  } catch {
    return null;
  }
}

function writeMcMeta(meta: MinecraftIndexMeta): void {
  const { metaPath } = getIndexPaths('minecraft');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

export type MinecraftIndexStatus = 'absent' | 'fresh' | 'stale' | 'building';

let building: AbortController | null = null;

export function isMinecraftIndexBuilding(): boolean {
  return building !== null;
}

export function getMinecraftIndexStatus(): MinecraftIndexStatus {
  if (building) return 'building';
  const meta = readMcMeta();
  if (!meta) return 'absent';
  if (
    meta.schemaVersion !== MC_INDEX_SCHEMA_VERSION ||
    meta.toolchain !== toolchainFingerprint() ||
    meta.symbolCount === 0
  ) {
    return 'stale';
  }
  return 'fresh';
}

export function cancelMinecraftIndexBuild(): void {
  building?.abort();
}

/**
 * Kick off an MC index build in the background if it's absent or stale. Returns
 * the status at call time so the caller can tell the user "building, retry
 * shortly". Safe to call repeatedly — the building guard dedups concurrent
 * triggers (e.g. a Minecraft conversation opening + the first search tool).
 */
export function ensureMinecraftIndexInBackground(
  onProgress: IndexProgressListener = () => {},
): MinecraftIndexStatus {
  const status = getMinecraftIndexStatus();
  if (status === 'absent' || status === 'stale') {
    void rebuildMinecraftIndex(onProgress).catch((err) => {
      console.error('[minecraft index] background build failed:', err);
    });
  }
  return status;
}

export async function rebuildMinecraftIndex(
  onProgress: IndexProgressListener,
  options: { signal?: AbortSignal } = {},
): Promise<MinecraftIndexMeta> {
  if (building) {
    throw new Error('A Minecraft index build is already in progress.');
  }
  const ctrl = new AbortController();
  building = ctrl;
  const signal = options.signal ?? ctrl.signal;
  const start = Date.now();
  try {
    onProgress({ type: 'starting', phases: ['decompile', 'symbols'] });

    onProgress({
      type: 'phase',
      phase: 'decompile',
      message: 'Preparing the Java 21 toolchain…',
    });
    await ensureJdk21();

    onProgress({
      type: 'phase',
      phase: 'decompile',
      message: 'Generating decompiled Minecraft sources (one-time, can take a few minutes)…',
    });
    const { sourcesJar } = await ensureMinecraftSources(undefined, signal);

    const { sourceRoot } = getIndexPaths('minecraft');
    onProgress({
      type: 'phase',
      phase: 'decompile',
      message: 'Extracting decompiled sources…',
    });
    await extractJar(sourcesJar, sourceRoot);
    if (signal.aborted) throw new Error('Index rebuild aborted');

    closeIndexDb('minecraft');
    const db = openIndexDb('minecraft');
    resetSchema(db);
    const { symbolCount, sourceBytes } = await indexJava(
      db,
      { sourceRoot },
      onProgress,
      signal,
    );

    const meta: MinecraftIndexMeta = {
      schemaVersion: MC_INDEX_SCHEMA_VERSION,
      toolchain: toolchainFingerprint(),
      symbolCount,
      sourceBytes,
      builtAt: new Date().toISOString(),
    };
    writeMcMeta(meta);
    onProgress({ type: 'done', durationMs: Date.now() - start });
    return meta;
  } catch (err) {
    onProgress({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    if (building === ctrl) building = null;
  }
}
