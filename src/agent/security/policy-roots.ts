import path from 'node:path';
import { detectRimWorldPaths } from '../paths.js';
import { getWorkspacePaths } from '../workspace.js';
import { getIndexPaths } from '../index/paths.js';
import { cookbookDir } from '../cookbook.js';
import type { PathPolicyRoots } from './path-policy.js';

/**
 * Resolve the live PathPolicyRoots from current Electron + RimWorld paths.
 * Cached for the process lifetime — these don't change while the app is
 * running, and we want zero overhead when a tool checks every call.
 *
 * Kept separate from path-policy.ts so the policy module stays pure (no
 * Electron imports), which matters because path-policy.ts ships into the
 * test runner without an `app` context.
 */
let cached: PathPolicyRoots | null = null;

export function getPathPolicyRoots(): PathPolicyRoots {
  if (cached) return cached;
  const { workspaceDir } = getWorkspacePaths();
  const rim = detectRimWorldPaths();
  const idx = getIndexPaths();
  cached = {
    workspaceDir,
    managedDir: rim.managedDir,
    dataDir: rim.dataDir,
    workshopDir: rim.workshopDir,
    rimworldModsDir: rim.modsDir,
    playerLogDir: rim.playerLog ? path.dirname(rim.playerLog) : null,
    indexDir: idx.root,
    cookbookDir: cookbookDir(),
  };
  return cached;
}

/** Test-only: clear the cache so suite setup can swap roots. */
export function __resetPathPolicyRootsForTests(): void {
  cached = null;
}

/**
 * Drop the cache so the next call re-resolves against the current RimWorld
 * paths. Used after the user picks a new install location during onboarding —
 * subsequent path-policy checks must consider the override.
 */
export function invalidatePathPolicyRoots(): void {
  cached = null;
}
