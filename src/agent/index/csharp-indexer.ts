import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
// web-tree-sitter is `export = Parser` (a class with a sibling namespace
// holding the inner types like Language and SyntaxNode). Type-only import
// is erased at compile time; the runtime constructor is loaded via
// loadParser() below since the bundled main.js can't satisfy a bare
// `require('web-tree-sitter')` in packaged builds (node_modules stripped).
import type Parser from 'web-tree-sitter';
import { resolveTreeSitterCsharpWasm } from './paths.js';
import type { IndexProgressListener } from './progress.js';

type SyntaxNode = Parser.SyntaxNode;
type Language = Parser.Language;

/**
 * Tree-sitter symbol extraction. We pull out:
 *   - Types (class, struct, interface, enum, record, delegate)
 *   - Methods (method_declaration, constructor_declaration)
 *   - Properties (property_declaration, indexer_declaration)
 *   - Fields (field_declaration — names extracted per-declarator)
 *
 * We DON'T try to capture local functions, lambdas, or expression-bodied
 * trivia — they're noise for the agent and inflate the symbol table without
 * useful jump-to-definition behavior.
 */

interface Symbol {
  fqn: string;
  shortName: string;
  kind: string;
  parentFqn: string | null;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string | null;
}

// Narrow interface — only the bits of the web-tree-sitter runtime we use.
// Avoids `typeof Parser` which TS rejects when Parser is a type-only import.
interface ParserInstance {
  setLanguage(lang: Language): void;
  parse(input: string): { rootNode: SyntaxNode };
}
interface ParserModule {
  new (): ParserInstance;
  init(): Promise<void>;
  Language: { load(path: string): Promise<Language> };
}

// web-tree-sitter's bundled emscripten output reassigns its own
// `module.exports = Module` from inside Parser.init(). After init runs, a
// subsequent require('web-tree-sitter') returns the emscripten Module instead
// of the Parser class — `new ParserCtor()` then throws "not a constructor".
// Capture the constructor on first load and reuse it.
let cachedParserCtor: ParserModule | null = null;

// Mirrors the dual-resolve pattern in src/agent/index/db.ts: bare require for
// dev (where node_modules is on disk), resourcesPath fallback for packaged
// builds where Forge ships node_modules/web-tree-sitter via extraResource.
function loadParser(): ParserModule {
  if (cachedParserCtor) return cachedParserCtor;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedParserCtor = require('web-tree-sitter') as ParserModule;
  } catch (devErr) {
    try {
      const resolved = path.join(process.resourcesPath, 'web-tree-sitter');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cachedParserCtor = require(resolved) as ParserModule;
    } catch (prodErr) {
      throw prodErr instanceof Error ? prodErr : devErr;
    }
  }
  return cachedParserCtor;
}

let languagePromise: Promise<Language> | null = null;

async function loadCSharpLanguage(): Promise<Language> {
  if (languagePromise) return languagePromise;
  languagePromise = (async () => {
    const wasmPath = resolveTreeSitterCsharpWasm();
    if (!wasmPath) {
      throw new Error(
        'tree-sitter-c-sharp.wasm is missing. Run `npm run fetch:tree-sitter`.',
      );
    }
    const ParserCtor = loadParser();
    await ParserCtor.init();
    return ParserCtor.Language.load(wasmPath);
  })();
  return languagePromise;
}

export interface IndexCsharpInput {
  /** $MM/index/Source/. */
  sourceRoot: string;
}

export async function indexCsharp(
  db: Database.Database,
  input: IndexCsharpInput,
  onProgress: IndexProgressListener,
  signal?: AbortSignal,
): Promise<{ symbolCount: number; defReferenceCount: number; sourceBytes: number }> {
  const CSharp = await loadCSharpLanguage();
  const ParserCtor = loadParser();
  const parser = new ParserCtor();
  parser.setLanguage(CSharp);

  const insertSymbol = db.prepare(`
    INSERT OR REPLACE INTO symbol
      (fqn, shortName, kind, parentFqn, filePath, startLine, endLine, signature)
    VALUES (@fqn, @shortName, @kind, @parentFqn, @filePath, @startLine, @endLine, @signature)
  `);
  const insertRef = db.prepare(`
    INSERT OR REPLACE INTO def_reference (defName, filePath, line)
    VALUES (@defName, @filePath, @line)
  `);

  const insertSymbolBatch = db.transaction((syms: Symbol[]) => {
    for (const s of syms) insertSymbol.run(s);
  });
  const insertRefBatch = db.transaction(
    (refs: { defName: string; filePath: string; line: number }[]) => {
      for (const r of refs) insertRef.run(r);
    },
  );

  // Build a Set of defNames so we can detect string-literal references in
  // C# source — "defName" → who_uses_def lookups. The set is small enough
  // (~10-20k entries) that membership tests are cheap.
  const defNames = new Set<string>();
  for (const row of db.prepare('SELECT DISTINCT defName FROM def WHERE defName IS NOT NULL').all() as { defName: string }[]) {
    defNames.add(row.defName);
  }

  const files = await listCsFiles(input.sourceRoot);
  let symbolCount = 0;
  let defReferenceCount = 0;
  let sourceBytes = 0;

  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) throw new Error('Index rebuild aborted');
    const abs = files[i];
    let content: string;
    try {
      content = await fsp.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    sourceBytes += Buffer.byteLength(content, 'utf8');

    // Skip files larger than ~1 MB — those are usually generated dumps that
    // produce thousands of synthetic symbols and slow the index without
    // adding signal. The agent can still grep them via search_source.
    if (content.length > 1_000_000) continue;

    const filePath = path
      .relative(input.sourceRoot, abs)
      .replaceAll('\\', '/');

    const tree = parser.parse(content);
    if (!tree) continue;
    const symbols: Symbol[] = [];
    walk(tree.rootNode, null, symbols, filePath);
    if (symbols.length > 0) insertSymbolBatch(symbols);
    symbolCount += symbols.length;

    // Def-reference scan: cheap regex over string literals. We accept some
    // false positives (e.g. "MyDef" appearing as a comment string) — the
    // agent will see the file path and resolve from there.
    const refs: { defName: string; filePath: string; line: number }[] = [];
    const stringRegex = /"([A-Z][A-Za-z0-9_]{2,})"/g;
    const lines = content.split(/\r?\n/);
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      stringRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = stringRegex.exec(line))) {
        const candidate = match[1];
        if (defNames.has(candidate)) {
          refs.push({ defName: candidate, filePath, line: lineIdx + 1 });
        }
      }
    }
    if (refs.length > 0) insertRefBatch(refs);
    defReferenceCount += refs.length;

    if (i % 50 === 0) {
      onProgress({
        type: 'phase',
        phase: 'symbols',
        message: `Indexing C# symbols… ${i}/${files.length}`,
        fraction: files.length > 0 ? i / files.length : undefined,
      });
    }
  }

  onProgress({
    type: 'phase',
    phase: 'symbols',
    message: `Indexed ${symbolCount} C# symbols across ${files.length} files`,
    fraction: 1,
  });

  return { symbolCount, defReferenceCount, sourceBytes };
}

async function listCsFiles(root: string): Promise<string[]> {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (e.isFile() && abs.toLowerCase().endsWith('.cs')) out.push(abs);
    }
  }
  return out;
}

/**
 * Walk a tree-sitter syntax tree and emit Symbol records for every type or
 * member we recognize. parentFqn threads through the recursion so nested
 * classes and members get the right qualified name.
 *
 * Tree-sitter node types come from tree-sitter-c-sharp's grammar — see
 * https://github.com/tree-sitter/tree-sitter-c-sharp/blob/master/src/grammar.json
 * for the canonical list.
 */
function walk(
  node: SyntaxNode,
  parentFqn: string | null,
  out: Symbol[],
  filePath: string,
): void {
  // Track namespace context so `Foo` inside `namespace RimWorld { class Foo }`
  // gets fqn `RimWorld.Foo` even though `namespace_declaration` doesn't emit
  // a Symbol of its own.
  if (node.type === 'namespace_declaration' || node.type === 'file_scoped_namespace_declaration') {
    const nameNode = node.childForFieldName('name');
    const name = nameNode ? nameNode.text : '';
    const nextParent = name ? (parentFqn ? `${parentFqn}.${name}` : name) : parentFqn;
    for (const child of node.namedChildren) {
      if (child) walk(child, nextParent, out, filePath);
    }
    return;
  }

  const typeKinds: Record<string, string> = {
    class_declaration: 'class',
    struct_declaration: 'struct',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
    record_declaration: 'record',
    record_struct_declaration: 'record',
    delegate_declaration: 'delegate',
  };

  if (typeKinds[node.type]) {
    const nameNode = node.childForFieldName('name');
    const shortName = nameNode ? nameNode.text : '<anonymous>';
    const fqn = parentFqn ? `${parentFqn}.${shortName}` : shortName;
    out.push({
      fqn,
      shortName,
      kind: typeKinds[node.type],
      parentFqn,
      filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: firstLine(node.text),
    });
    for (const child of node.namedChildren) {
      if (child) walk(child, fqn, out, filePath);
    }
    return;
  }

  if (node.type === 'method_declaration' || node.type === 'constructor_declaration') {
    const nameNode = node.childForFieldName('name');
    const shortName = nameNode ? nameNode.text : '<anonymous>';
    const fqn = parentFqn ? `${parentFqn}.${shortName}` : shortName;
    out.push({
      fqn,
      shortName,
      kind: node.type === 'constructor_declaration' ? 'constructor' : 'method',
      parentFqn,
      filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: firstLine(node.text),
    });
    return;
  }

  if (node.type === 'property_declaration' || node.type === 'indexer_declaration') {
    const nameNode = node.childForFieldName('name');
    const shortName = nameNode ? nameNode.text : '<anonymous>';
    const fqn = parentFqn ? `${parentFqn}.${shortName}` : shortName;
    out.push({
      fqn,
      shortName,
      kind: node.type === 'indexer_declaration' ? 'indexer' : 'property',
      parentFqn,
      filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: firstLine(node.text),
    });
    return;
  }

  if (node.type === 'field_declaration' || node.type === 'event_field_declaration') {
    // Field declarations contain a `variable_declaration` with one or more
    // `variable_declarator`s. Emit one Symbol per declarator.
    for (const declarator of findChildrenOfType(node, 'variable_declarator')) {
      const nameNode = declarator.childForFieldName('name');
      const shortName = nameNode ? nameNode.text : '<anonymous>';
      const fqn = parentFqn ? `${parentFqn}.${shortName}` : shortName;
      out.push({
        fqn,
        shortName,
        kind: node.type === 'event_field_declaration' ? 'event' : 'field',
        parentFqn,
        filePath,
        startLine: declarator.startPosition.row + 1,
        endLine: declarator.endPosition.row + 1,
        signature: firstLine(node.text),
      });
    }
    return;
  }

  for (const child of node.namedChildren) {
    if (child) walk(child, parentFqn, out, filePath);
  }
}

function firstLine(s: string): string {
  const idx = s.indexOf('\n');
  const line = idx >= 0 ? s.slice(0, idx) : s;
  return line.length > 240 ? line.slice(0, 237) + '…' : line.trim();
}

function findChildrenOfType(
  node: SyntaxNode,
  type: string,
): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const queue: SyntaxNode[] = [node];
  while (queue.length) {
    const cur = queue.pop()!;
    for (const child of cur.namedChildren) {
      if (!child) continue;
      if (child.type === type) out.push(child);
      else queue.push(child);
    }
  }
  return out;
}
