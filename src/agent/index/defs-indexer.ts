import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import type Database from 'better-sqlite3';
import type { IndexProgressListener } from './progress.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  allowBooleanAttributes: true,
  trimValues: true,
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  format: true,
  indentBy: '  ',
  suppressEmptyNode: false,
});

interface IndexedDef {
  pack: string;
  defType: string;
  defName: string | null;
  inheritName: string | null;
  parentName: string | null;
  abstract: number;
  label: string;
  description: string;
  filePath: string;
  startLine: number | null;
  xml: string;
}

/**
 * Walk a Defs root and return every def we can recognize. `pack` is the label
 * we tag the output with — "Core", "Royalty", or "Mod:<id>".
 */
async function scanDefsTree(
  defsRoot: string,
  pack: string,
  /** Path that gets stored as `filePath` (relative to the index root). */
  filePathBase: string,
): Promise<IndexedDef[]> {
  if (!fs.existsSync(defsRoot)) return [];
  const out: IndexedDef[] = [];
  const queue: string[] = [defsRoot];
  while (queue.length) {
    const dir = queue.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(abs);
        continue;
      }
      if (!entry.isFile() || !abs.toLowerCase().endsWith('.xml')) continue;
      let raw: string;
      try {
        raw = await fsp.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = parser.parse(raw);
      } catch {
        continue;
      }
      const root = (parsed as Record<string, unknown> | undefined)?.Defs;
      if (!root || typeof root !== 'object') continue;
      const rel = path.relative(defsRoot, abs);
      const filePath = path.join(filePathBase, rel);
      for (const [defType, value] of Object.entries(root as Record<string, unknown>)) {
        const items = Array.isArray(value) ? value : [value];
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          const obj = item as Record<string, unknown>;
          const defName = stringField(obj.defName) || null;
          const inheritName = attrField(obj['@_Name']) || null;
          const parentName = attrField(obj['@_ParentName']) || null;
          const abstractAttr = attrField(obj['@_Abstract']);
          const label = stringField(obj.label);
          const description = stringField(obj.description);
          let xmlBody = '';
          try {
            xmlBody = builder.build({ [defType]: obj }).toString().trim();
          } catch {
            xmlBody = '';
          }
          out.push({
            pack,
            defType,
            defName,
            inheritName,
            parentName,
            abstract: abstractAttr === 'True' || abstractAttr === 'true' ? 1 : 0,
            label,
            description,
            filePath: filePath.replaceAll('\\', '/'),
            startLine: null, // fast-xml-parser drops line info; OK for v1
            xml: xmlBody,
          });
        }
      }
    }
  }
  return out;
}

function stringField(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  return '';
}

function attrField(v: unknown): string {
  if (typeof v === 'string') return v;
  return '';
}

/**
 * Mirror a Defs tree into the index's Defs/<pack>/ subdir. We copy rather
 * than parse-and-rewrite because the agent's read tool will read the file
 * back later, and original whitespace + comments are useful context.
 */
async function copyDefsTree(srcRoot: string, destRoot: string): Promise<void> {
  if (!fs.existsSync(srcRoot)) return;
  const queue: Array<[string, string]> = [[srcRoot, destRoot]];
  while (queue.length) {
    const [src, dest] = queue.pop()!;
    fs.mkdirSync(dest, { recursive: true });
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(src, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const srcAbs = path.join(src, entry.name);
      const destAbs = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        queue.push([srcAbs, destAbs]);
      } else if (entry.isFile() && srcAbs.toLowerCase().endsWith('.xml')) {
        await fsp.copyFile(srcAbs, destAbs);
      }
    }
  }
}

export interface IndexDefsInput {
  /** Path to RimWorld Data/ — contains Core, Royalty, etc. */
  dataDir: string;
  /** Names of pack dirs under Data/ to index (Core + DLC the user owns). */
  dlcs: string[];
  /** Optional list of {modName, modDefsRoot} to also include. */
  enabledMods?: { id: string; defsRoot: string }[];
  /** $MM/index/Defs/. */
  defsIndexRoot: string;
}

export async function indexDefs(
  db: Database.Database,
  input: IndexDefsInput,
  onProgress: IndexProgressListener,
): Promise<number> {
  // Wipe the existing Defs/ tree in the index (we mirror, not merge).
  if (fs.existsSync(input.defsIndexRoot)) {
    await fsp.rm(input.defsIndexRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(input.defsIndexRoot, { recursive: true });

  const insert = db.prepare(`
    INSERT INTO def
      (pack, defType, defName, inheritName, parentName, abstract,
       label, description, filePath, startLine, xml)
    VALUES (@pack, @defType, @defName, @inheritName, @parentName, @abstract,
            @label, @description, @filePath, @startLine, @xml)
  `);
  // last_insert_rowid() returns the autoincremented `id` from the def
  // INSERT immediately above, which becomes the FTS rowid (content_rowid
  // is configured to map to def.id).
  const insertFts = db.prepare(`
    INSERT INTO def_fts (rowid, defName, label, description)
    VALUES (last_insert_rowid(), @defName, @label, @description)
  `);

  let total = 0;
  const insertAll = db.transaction((defs: IndexedDef[]) => {
    for (const d of defs) {
      insert.run(d);
      // FTS5 with content='def' would need a manual rebuild; instead we
      // populate the contentless index directly with the same rowid scheme.
      insertFts.run({
        defName: d.defName ?? '',
        label: d.label,
        description: d.description,
      });
      total++;
    }
  });

  // Phase progress: total work units = packs + mods.
  const totalUnits = input.dlcs.length + (input.enabledMods?.length ?? 0);
  let unitsDone = 0;
  const tick = (msg: string) => {
    unitsDone++;
    onProgress({
      type: 'phase',
      phase: 'defs',
      message: msg,
      fraction: totalUnits > 0 ? unitsDone / totalUnits : undefined,
    });
  };

  for (const pack of input.dlcs) {
    onProgress({
      type: 'phase',
      phase: 'defs',
      message: `Indexing ${pack} defs…`,
      fraction: totalUnits > 0 ? unitsDone / totalUnits : undefined,
    });
    const srcDefs = path.join(input.dataDir, pack, 'Defs');
    const destDefs = path.join(input.defsIndexRoot, pack);
    await copyDefsTree(srcDefs, destDefs);
    const defs = await scanDefsTree(srcDefs, pack, pack);
    insertAll(defs);
    tick(`Indexed ${pack} (${defs.length} defs)`);
  }

  for (const mod of input.enabledMods ?? []) {
    onProgress({
      type: 'phase',
      phase: 'defs',
      message: `Indexing mod ${mod.id} defs…`,
      fraction: totalUnits > 0 ? unitsDone / totalUnits : undefined,
    });
    const pack = `Mod:${mod.id}`;
    const destDefs = path.join(input.defsIndexRoot, 'Mods', mod.id);
    await copyDefsTree(mod.defsRoot, destDefs);
    const defs = await scanDefsTree(
      mod.defsRoot,
      pack,
      path.join('Mods', mod.id),
    );
    insertAll(defs);
    tick(`Indexed mod ${mod.id} (${defs.length} defs)`);
  }

  return total;
}
