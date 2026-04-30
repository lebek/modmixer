import path from 'node:path';
import { detectRimWorldPaths } from '../paths.js';
import { getWorkspacePaths } from '../workspace.js';
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
  cached = {
    workspaceDir,
    managedDir: rim.managedDir,
    workshopDir: rim.workshopDir,
    rimworldModsDir: rim.modsDir,
    playerLogDir: rim.playerLog ? path.dirname(rim.playerLog) : null,
  };
  return cached;
}

/** Test-only: clear the cache so suite setup can swap roots. */
export function __resetPathPolicyRootsForTests(): void {
  cached = null;
}
