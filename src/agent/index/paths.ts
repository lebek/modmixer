import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { GameId } from '../games/types.js';

/**
 * Disk layout for the RimWorld source/def index. Lives under userData so the
 * user can `rm -rf` it without losing their actual data, and so the agent's
 * path-policy allowlist can include the index root without exposing anything
 * else. See {@link IndexPaths} for the individual subdirectories.
 */
export interface IndexPaths {
  /** Root of the index (everything else is under here). */
  root: string;
  /** $root/Defs/<Pack>/... — mirror of `<RimWorld>/Data/<Pack>/Defs/`. */
  defsRoot: string;
  /** $root/Source/<Assembly>/... — decompiled C# trees per assembly. */
  sourceRoot: string;
  /** SQLite DB with defs + symbols + def-references. */
  dbPath: string;
  /** JSON sidecar with cache key + build metadata. */
  metaPath: string;
}

/**
 * Per-game index root. RimWorld keeps the legacy `index/` path so existing
 * indexes aren't invalidated; every other game gets `index/<gameId>/`. The
 * subdir names (Defs/, Source/) are reused across games even though Minecraft
 * stores decompiled Java under Source/ and vanilla JSON data under Defs/ — the
 * SQLite schema and search tools are language-agnostic.
 */
export function getIndexPaths(gameId: GameId = 'rimworld'): IndexPaths {
  const base = path.join(app.getPath('userData'), 'index');
  const root = gameId === 'rimworld' ? base : path.join(base, gameId);
  fs.mkdirSync(root, { recursive: true });
  return {
    root,
    defsRoot: path.join(root, 'Defs'),
    sourceRoot: path.join(root, 'Source'),
    dbPath: path.join(root, 'index.sqlite'),
    metaPath: path.join(root, 'meta.json'),
  };
}

/**
 * Resolve a packaged resource directory. In dev (running from source) the
 * resource lives under the repo's `resources/` dir; in packaged builds it's
 * copied into Electron's `resourcesPath`. Callers pass the relative subpath
 * (e.g. `'ilspycmd/darwin-arm64/ilspycmd'`).
 *
 * `app.isPackaged` is unreliable when running through `electron-forge start`
 * (the bundled main.js is loaded via .vite/build and Electron sometimes
 * reports it as packaged). So try the dev path first, fall back to
 * resourcesPath if it doesn't exist on disk. The dev path resolves to the
 * project root; packaged builds don't have a project root, so the second
 * branch is what fires there.
 */
export function resolvePackagedResource(relPath: string): string {
  const devCandidate = path.join(app.getAppPath(), 'resources', relPath);
  if (fs.existsSync(devCandidate)) return devCandidate;
  return path.join(process.resourcesPath, relPath);
}

/**
 * Locate the vendored ilspycmd binary for the current host. Returns null if
 * the per-platform subdir doesn't have a binary (release build skipped the
 * fetch step, or running in dev without populating resources/ilspycmd/).
 */
export function resolveVendoredIlspycmd(): string | null {
  const platform = process.platform;
  const arch = process.arch;
  const exe = platform === 'win32' ? 'ilspycmd.exe' : 'ilspycmd';
  const candidate = resolvePackagedResource(
    path.join('ilspycmd', `${platform}-${arch}`, exe),
  );
  return fs.existsSync(candidate) ? candidate : null;
}

/** Path to the prebuilt tree-sitter C# grammar wasm. Null if not fetched. */
export function resolveTreeSitterCsharpWasm(): string | null {
  const candidate = resolvePackagedResource('tree-sitter/tree-sitter-c-sharp.wasm');
  return fs.existsSync(candidate) ? candidate : null;
}

/** Path to the prebuilt tree-sitter Java grammar wasm (Minecraft index). Null if not fetched. */
export function resolveTreeSitterJavaWasm(): string | null {
  const candidate = resolvePackagedResource('tree-sitter/tree-sitter-java.wasm');
  return fs.existsSync(candidate) ? candidate : null;
}
