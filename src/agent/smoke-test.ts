// CI smoke test: exercise every packaging-time risk in the shipped installer.
// Designed to catch the class of bugs that recently shipped past CI:
//   - better-sqlite3 ABI mismatch (v0.6.1)
//   - missing hoisted runtime deps `bindings`/`file-uri-to-path` (v0.6.0)
//   - web-tree-sitter ParserCtor cache mutation (intermittent in dev, deterministic
//     in a fresh process)
//   - missing/wrong-arch ripgrep binary (extraResource omission, cross-arch make)
//   - missing/wrong-arch ilspycmd binary (CI-only fetch step skipped locally)
//
// Each step exercises a different shipped artifact. Failures here mean the
// installer can't possibly work for end users, so we exit non-zero and the
// release workflow rejects the build.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { closeIndexDb, openIndexDb } from './index/db.js';
import { loadCSharpLanguage, loadParser } from './index/csharp-indexer.js';
import { resolveTreeSitterCsharpWasm, resolveVendoredIlspycmd } from './index/paths.js';

const FIXTURE_CSHARP = `
namespace SmokeTest
{
    public class Foo
    {
        public int Bar(string s) { return s.Length; }
        public string Baz { get; set; }
    }
}
`;

const SPAWN_TIMEOUT_MS = 10_000;

export async function runSmokeTest(): Promise<void> {
  // 1. better-sqlite3: open + close. Catches NODE_MODULE_VERSION mismatch
  //    (Node ABI vs Electron ABI) and missing hoisted deps `bindings` /
  //    `file-uri-to-path`.
  // eslint-disable-next-line no-console
  console.log('[smoke-test] step 1/4: better-sqlite3 open + close');
  openIndexDb();
  closeIndexDb();

  // 2. tree-sitter + C# grammar wasm: load parser, init emscripten, load
  //    grammar, parse a fixture string. Catches missing web-tree-sitter
  //    extraResource, missing tree-sitter-c-sharp.wasm, the ParserCtor
  //    cache-mutation bug (web-tree-sitter@0.24.x mutates module.exports
  //    inside Parser.init() — second require gets the inner Module, not
  //    the constructor).
  // eslint-disable-next-line no-console
  console.log('[smoke-test] step 2/4: tree-sitter + C# grammar parse');
  await parseCSharpFixture();

  // 3. ripgrep: spawn the bundled binary with --version. Catches missing
  //    @vscode/ripgrep extraResource and wrong-arch binary (a cross-arch
  //    make can ship the host-arch rg.exe to a different-arch user).
  // eslint-disable-next-line no-console
  console.log('[smoke-test] step 3/4: ripgrep --version');
  const rgPath = resolveRipgrepBinary();
  await runBinary('ripgrep', rgPath, ['--version']);

  // 4. ilspycmd: spawn the vendored binary. Catches missing fetch:ilspycmd
  //    output (CI-only step that's easy to skip in local builds) and arch
  //    mismatch. ilspycmd --help exits 0 on success.
  // eslint-disable-next-line no-console
  console.log('[smoke-test] step 4/4: ilspycmd --help');
  const ilspycmd = resolveVendoredIlspycmd();
  if (!ilspycmd) {
    throw new Error(
      `vendored ilspycmd missing for ${process.platform}-${process.arch}. ` +
        'Run `npm run fetch:ilspycmd` before packaging.',
    );
  }
  await runBinary('ilspycmd', ilspycmd, ['--help']);

  // eslint-disable-next-line no-console
  console.log('[smoke-test] all steps OK');
}

async function parseCSharpFixture(): Promise<void> {
  const wasm = resolveTreeSitterCsharpWasm();
  if (!wasm) {
    throw new Error(
      'tree-sitter C# grammar wasm not found. Run `npm run fetch:tree-sitter`.',
    );
  }
  const ParserCtor = loadParser();
  const CSharp = await loadCSharpLanguage();
  const parser = new ParserCtor();
  parser.setLanguage(CSharp);
  const tree = parser.parse(FIXTURE_CSHARP);
  if (!tree.rootNode || tree.rootNode.childCount === 0) {
    throw new Error('tree-sitter parse produced an empty tree');
  }
}

function resolveRipgrepBinary(): string {
  // Mirror the dual-resolve pattern in src/agent/tools/search-source.ts so
  // the smoke test exercises the same resolution as the real tool.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@vscode/ripgrep') as { rgPath: string };
    return mod.rgPath;
  } catch {
    const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
    return path.join(process.resourcesPath, 'ripgrep', 'bin', exe);
  }
}

function runBinary(label: string, exe: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { stdio: 'ignore' });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`[smoke-test] ${label} timed out after ${SPAWN_TIMEOUT_MS}ms`));
    }, SPAWN_TIMEOUT_MS);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`[smoke-test] ${label} spawn failed: ${err.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`[smoke-test] ${label} exited with code ${code}`));
      }
    });
  });
}
