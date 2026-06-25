import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureJdk21 } from '../minecraft/jdk.js';
import { resolveVendoredVineflower } from './paths.js';

/**
 * Decompiling an installed mod jar with Vineflower — the Minecraft analog of
 * decompile_dll's ilspycmd path. We don't ship pre-decompiled mod source (it's
 * the user's installed content), so inspect_mod runs this on demand. NeoForge
 * 1.21.1 mods are compiled against mojmap at runtime, so the output references
 * vanilla by readable `net.minecraft.*` names with no remapping step.
 *
 * Given a jar input and a directory output, Vineflower writes the decompiled
 * `.java` straight into that directory as a loose package tree (it also passes
 * through the jar's non-class resources) — no intermediate sources jar.
 */

export interface DecompileResult {
  ok: boolean;
  /** Count of .java files written under outDir (0 ⇒ nothing decompiled). */
  javaFiles: number;
  /** Tail of Vineflower's log; populated for diagnostics when ok === false. */
  log: string;
}

/** Locate the vendored Vineflower jar, or null when not bundled (skipped fetch). */
export function resolveVineflower(): string | null {
  return resolveVendoredVineflower();
}

function javaBin(home: string): string {
  return path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
}

function tail(s: string, max = 2000): string {
  const t = s.trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

function run(
  cmd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    let out = '';
    proc.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    const onAbort = () => proc.kill();
    signal?.addEventListener('abort', onAbort);
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ code: code ?? -1, out });
    });
    proc.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ code: -1, out: out + (err instanceof Error ? err.message : String(err)) });
    });
  });
}

async function countJavaFiles(dir: string): Promise<number> {
  let n = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop() as string;
    const entries = await fsp.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.java')) n++;
    }
  }
  return n;
}

/**
 * Decompile `jar`'s classes into `outDir` (created if absent) as loose .java.
 * Never throws — returns ok=false with a log tail so inspect_mod can degrade to
 * a metadata + resources view when the decompiler is missing or the jar is
 * obfuscated/unsupported.
 */
export async function decompileJar(
  jar: string,
  outDir: string,
  signal?: AbortSignal,
): Promise<DecompileResult> {
  const vineflower = resolveVineflower();
  if (!vineflower) {
    return {
      ok: false,
      javaFiles: 0,
      log: 'Vineflower is not vendored (resources/vineflower/vineflower.jar missing). Run `npm run fetch:vineflower`.',
    };
  }
  try {
    const { home } = await ensureJdk21();
    await fsp.mkdir(outDir, { recursive: true });
    // `java -jar vineflower.jar <input.jar> <outDir>` writes the decompiled
    // .java straight into outDir as a loose package tree.
    const { code, out } = await run(javaBin(home), ['-jar', vineflower, jar, outDir], signal);
    const javaFiles = await countJavaFiles(outDir);
    if (javaFiles === 0) {
      return {
        ok: false,
        javaFiles: 0,
        log: tail(out) || `Vineflower exited ${code} without producing any .java.`,
      };
    }
    return { ok: true, javaFiles, log: '' };
  } catch (err) {
    return {
      ok: false,
      javaFiles: 0,
      log: err instanceof Error ? err.message : String(err),
    };
  }
}
