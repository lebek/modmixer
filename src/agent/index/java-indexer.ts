import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type Parser from 'web-tree-sitter';
import { resolveTreeSitterJavaWasm } from './paths.js';
import { loadParser } from './csharp-indexer.js';
import type { IndexProgressListener } from './progress.js';

type SyntaxNode = Parser.SyntaxNode;
type Language = Parser.Language;

/**
 * Tree-sitter symbol extraction for Java — the Minecraft analogue of
 * csharp-indexer.ts. We index the decompiled, Parchment-mapped Minecraft +
 * NeoForge sources (net.minecraft.*, net.neoforged.neoforge.*) into the SAME
 * `symbol` table the RimWorld index uses, so read_symbol / search_source work
 * identically. We pull out types, methods/constructors, fields, and enum
 * constants — not locals or lambdas.
 *
 * Unlike C#'s `namespace { ... }` (which contains its types), Java's
 * `package` is a sibling statement, so the package name is resolved per-file
 * and threaded in as the root parentFqn.
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

interface ParserInstance {
  setLanguage(lang: Language): void;
  parse(input: string): { rootNode: SyntaxNode };
}
interface ParserModule {
  new (): ParserInstance;
  init(): Promise<void>;
  Language: { load(path: string): Promise<Language> };
}

let languagePromise: Promise<Language> | null = null;

export async function loadJavaLanguage(): Promise<Language> {
  if (languagePromise) return languagePromise;
  languagePromise = (async () => {
    const wasmPath = resolveTreeSitterJavaWasm();
    if (!wasmPath) {
      throw new Error(
        'tree-sitter-java.wasm is missing. Run `npm run fetch:tree-sitter-java`.',
      );
    }
    const ParserCtor = loadParser() as unknown as ParserModule;
    await ParserCtor.init();
    return ParserCtor.Language.load(wasmPath);
  })();
  return languagePromise;
}

export interface IndexJavaInput {
  /** $MM/index/<game>/Source/. */
  sourceRoot: string;
}

export async function indexJava(
  db: Database.Database,
  input: IndexJavaInput,
  onProgress: IndexProgressListener,
  signal?: AbortSignal,
): Promise<{ symbolCount: number; defReferenceCount: number; sourceBytes: number }> {
  const Java = await loadJavaLanguage();
  const ParserCtor = loadParser() as unknown as ParserModule;
  const parser = new ParserCtor();
  parser.setLanguage(Java);

  const insertSymbol = db.prepare(`
    INSERT OR REPLACE INTO symbol
      (fqn, shortName, kind, parentFqn, filePath, startLine, endLine, signature)
    VALUES (@fqn, @shortName, @kind, @parentFqn, @filePath, @startLine, @endLine, @signature)
  `);
  const insertSymbolBatch = db.transaction((syms: Symbol[]) => {
    for (const s of syms) insertSymbol.run(s);
  });

  const files = await listJavaFiles(input.sourceRoot);
  let symbolCount = 0;
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
    if (content.length > 1_000_000) continue;

    const filePath = path.relative(input.sourceRoot, abs).replaceAll('\\', '/');
    const tree = parser.parse(content);
    if (!tree) continue;
    const pkg = findPackageName(tree.rootNode);
    const symbols: Symbol[] = [];
    walkJava(tree.rootNode, pkg, symbols, filePath);
    if (symbols.length > 0) insertSymbolBatch(symbols);
    symbolCount += symbols.length;

    if (i % 50 === 0) {
      onProgress({
        type: 'phase',
        phase: 'symbols',
        message: `Indexing Java symbols… ${i}/${files.length}`,
        fraction: files.length > 0 ? i / files.length : undefined,
      });
    }
  }

  onProgress({
    type: 'phase',
    phase: 'symbols',
    message: `Indexed ${symbolCount} Java symbols across ${files.length} files`,
    fraction: 1,
  });

  // def_reference cross-refs are RimWorld-defName specific; Minecraft ids are
  // namespaced (minecraft:stone) and live in the data index, so we skip them.
  return { symbolCount, defReferenceCount: 0, sourceBytes };
}

async function listJavaFiles(root: string): Promise<string[]> {
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
      else if (e.isFile() && abs.toLowerCase().endsWith('.java')) out.push(abs);
    }
  }
  return out;
}

/** Java's `package a.b.c;` is a sibling statement — pull it out for the file. */
function findPackageName(root: SyntaxNode): string | null {
  for (const child of root.namedChildren) {
    if (!child || child.type !== 'package_declaration') continue;
    for (const c of child.namedChildren) {
      if (c && (c.type === 'scoped_identifier' || c.type === 'identifier')) {
        return c.text;
      }
    }
  }
  return null;
}

const JAVA_TYPE_KINDS: Record<string, string> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  record_declaration: 'record',
  annotation_type_declaration: 'annotation',
};

function walkJava(
  node: SyntaxNode,
  parentFqn: string | null,
  out: Symbol[],
  filePath: string,
): void {
  const typeKind = JAVA_TYPE_KINDS[node.type];
  if (typeKind) {
    const nameNode = node.childForFieldName('name');
    const shortName = nameNode ? nameNode.text : '<anonymous>';
    const fqn = parentFqn ? `${parentFqn}.${shortName}` : shortName;
    out.push({
      fqn,
      shortName,
      kind: typeKind,
      parentFqn,
      filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: firstLine(node.text),
    });
    for (const child of node.namedChildren) {
      if (child) walkJava(child, fqn, out, filePath);
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

  if (node.type === 'field_declaration') {
    for (const declarator of findChildrenOfType(node, 'variable_declarator')) {
      const nameNode = declarator.childForFieldName('name');
      const shortName = nameNode ? nameNode.text : '<anonymous>';
      const fqn = parentFqn ? `${parentFqn}.${shortName}` : shortName;
      out.push({
        fqn,
        shortName,
        kind: 'field',
        parentFqn,
        filePath,
        startLine: declarator.startPosition.row + 1,
        endLine: declarator.endPosition.row + 1,
        signature: firstLine(node.text),
      });
    }
    return;
  }

  if (node.type === 'enum_constant') {
    const nameNode = node.childForFieldName('name');
    const shortName = nameNode ? nameNode.text : '<anonymous>';
    const fqn = parentFqn ? `${parentFqn}.${shortName}` : shortName;
    out.push({
      fqn,
      shortName,
      kind: 'enum_constant',
      parentFqn,
      filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: firstLine(node.text),
    });
    return;
  }

  for (const child of node.namedChildren) {
    if (child) walkJava(child, parentFqn, out, filePath);
  }
}

function firstLine(s: string): string {
  const idx = s.indexOf('\n');
  const line = idx >= 0 ? s.slice(0, idx) : s;
  return line.length > 240 ? line.slice(0, 237) + '…' : line.trim();
}

function findChildrenOfType(node: SyntaxNode, type: string): SyntaxNode[] {
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
