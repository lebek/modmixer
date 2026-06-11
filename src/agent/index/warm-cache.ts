import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { getIndexPaths } from './paths.js';
import { getIndexStatus, isRebuilding } from './rebuild.js';
import { resolveRipgrep } from './ripgrep.js';

/**
 * Throwaway ripgrep sweep over the decompiled C# + Defs corpus so the first
 * real search_source call isn't the one paying the cold-cache tax. On
 * Windows a cold tree costs ~40s (Defender real-time protection scans all
 * ~10k files on first access after a reboot, signature update, or memory-
 * pressure eviction); warm it's ~0.6s. The pattern can never match, so rg
 * reads every byte but allocates no output, and `-q` keeps it silent.
 *
 * Fired (and forgotten) from three triggers: rebuild completion, app start
 * with a usable index, and agent session construction (new or reopened
 * chat). The in-flight guard and cooldown make overlapping triggers free.
 */

const COOLDOWN_MS = 5 * 60 * 1000;
const NEVER_MATCH = 'ZzQqModmixerWarmSweepNeverMatchesXxJj';

let inFlight: Promise<void> | null = null;
let lastCompletedAt = 0;

export function warmSearchCache(reason: string): Promise<void> {
  if (inFlight) return inFlight;
  if (Date.now() - lastCompletedAt < COOLDOWN_MS) return Promise.resolve();
  // A rebuild rewrites the tree out from under the sweep, and triggers a
  // fresh warm of its own when it finishes — skip rather than race it.
  if (isRebuilding()) return Promise.resolve();
  const status = getIndexStatus();
  if (status.type === 'absent' || status.type === 'no-rimworld') {
    return Promise.resolve();
  }
  const rg = resolveRipgrep();
  if (!rg) return Promise.resolve();
  const { sourceRoot, defsRoot } = getIndexPaths();
  if (!fs.existsSync(sourceRoot)) return Promise.resolve();

  // Mirror search_source's traversal flags so the sweep touches exactly the
  // file set real searches will read.
  const args = ['-q', '--max-filesize', '1M', '-e', NEVER_MATCH, sourceRoot];
  if (fs.existsSync(defsRoot)) args.push(defsRoot);

  const start = Date.now();
  inFlight = new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      lastCompletedAt = Date.now();
      inFlight = null;
      console.log(
        `[index] warm sweep (${reason}) finished in ${lastCompletedAt - start}ms`,
      );
      resolve();
    };
    try {
      const proc = spawn(rg, args, { stdio: 'ignore' });
      proc.on('close', done);
      proc.on('error', done);
    } catch {
      done();
    }
  });
  return inFlight;
}
