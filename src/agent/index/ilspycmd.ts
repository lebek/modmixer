import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveVendoredIlspycmd } from './paths.js';

/**
 * Locate ilspycmd. Prefer the vendored single-file binary we ship with
 * Electron's resources (no .NET SDK on the user's machine required).
 * Fall back to a user-installed `dotnet tool install -g ilspycmd` so dev
 * environments without the vendored binary still work.
 */
export function resolveIlspycmd(): string | null {
  const vendored = resolveVendoredIlspycmd();
  if (vendored) return vendored;

  const exe = process.platform === 'win32' ? 'ilspycmd.exe' : 'ilspycmd';
  const home = os.homedir();
  const candidates: string[] = [path.join(home, '.dotnet', 'tools', exe)];
  if (process.env.DOTNET_CLI_HOME) {
    candidates.push(path.join(process.env.DOTNET_CLI_HOME, '.dotnet', 'tools', exe));
  }
  const pathEnv = process.env.PATH ?? '';
  for (const entry of pathEnv.split(path.delimiter)) {
    if (!entry) continue;
    const expanded = entry.startsWith('~')
      ? path.join(home, entry.slice(1))
      : entry;
    candidates.push(path.join(expanded, exe));
  }
  for (const c of candidates) {
    try {
      const mode = process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
      fs.accessSync(c, mode);
      return c;
    } catch {
      // try next
    }
  }
  return null;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function runIlspycmd(
  cmd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const onAbort = () => proc.kill();
    signal?.addEventListener('abort', onAbort);
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: -1,
        stdout,
        stderr: stderr + (err instanceof Error ? err.message : String(err)),
      });
    });
  });
}
