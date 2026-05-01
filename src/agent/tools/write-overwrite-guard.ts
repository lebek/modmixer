import path from 'node:path';
import fs from 'node:fs';
import { homedir } from 'node:os';

/**
 * Standalone existence check used by the guarded write tool. Pulled out of
 * `path-guarded.ts` because that module imports `@mariozechner/pi-coding-agent`,
 * which transitively pulls in Electron — the test runner can't load it. This
 * module has only stdlib imports so the rule is unit-testable in isolation.
 */

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve `rawPath` the same way pi's write tool does (cwd-relative if not
 * absolute, expand `~`) and throw if the file already exists. New files
 * pass silently — the wrapping tool then delegates to pi's write tool.
 */
export function assertWriteTargetIsNew(rawPath: string, cwd: string): void {
  const expanded = expandHome(rawPath);
  const abs = path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
  if (fs.existsSync(abs)) {
    throw new Error(
      `${abs} already exists. Use the \`edit\` tool to modify existing files — it streams only the diff, while \`write\` re-sends the entire file. If you really need to replace the whole file, \`edit\` with the full current contents as oldText and the new contents as newText.`,
    );
  }
}
