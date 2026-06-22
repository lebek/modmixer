import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { IndexProgressListener } from './progress.js';

/**
 * Minecraft data/asset JSON indexer — the analogue of defs-indexer.ts (RimWorld
 * XML). Minecraft 1.21 is heavily data-driven: recipes, loot tables, tags,
 * advancements, worldgen (data/<ns>/...) and models, blockstates, lang
 * (assets/<ns>/...) are all JSON. We index each by its namespaced id into the
 * shared `def` table (the `xml` column holds the raw JSON), so search_defs can
 * find "diamond_sword" or filter by defType='recipe' exactly as it does for
 * RimWorld defs.
 *
 * Path → identity:
 *   data/minecraft/recipe/diamond_sword.json
 *     → pack="minecraft", defType="recipe", defName="minecraft:diamond_sword"
 *   data/minecraft/loot_table/blocks/stone.json
 *     → defType="loot_table", defName="minecraft:blocks/stone"
 *   assets/minecraft/models/item/diamond.json
 *     → defType="models", defName="minecraft:item/diamond"
 */

interface DataDef {
  pack: string;
  defType: string;
  defName: string;
  label: string | null;
  description: string | null;
  filePath: string;
  xml: string;
}

export interface IndexMinecraftDataInput {
  /** $MM/index/minecraft/Defs/ — extracted data/ + assets/ JSON trees. */
  dataRoot: string;
}

// Cap stored content — most recipes/loot tables are tiny, but some worldgen and
// lang files are large; search_source (ripgrep over the same tree) covers the
// full text, so the stored def body is just for search_defs convenience.
const MAX_STORED = 64 * 1024;

export async function indexMinecraftData(
  db: Database.Database,
  input: IndexMinecraftDataInput,
  onProgress: IndexProgressListener,
  signal?: AbortSignal,
): Promise<number> {
  const insertDef = db.prepare(`
    INSERT INTO def
      (pack, defType, defName, inheritName, parentName, abstract, label, description, filePath, startLine, xml)
    VALUES
      (@pack, @defType, @defName, NULL, NULL, 0, @label, @description, @filePath, NULL, @xml)
  `);
  const insertFts = db.prepare(`
    INSERT INTO def_fts (rowid, defName, label, description)
    VALUES (@rowid, @defName, @label, @description)
  `);
  const insertBatch = db.transaction((rows: DataDef[]) => {
    for (const r of rows) {
      const info = insertDef.run(r);
      insertFts.run({
        rowid: info.lastInsertRowid,
        defName: r.defName,
        label: r.label,
        description: r.description,
      });
    }
  });

  const files = await listJsonFiles(input.dataRoot);
  let defCount = 0;
  const batch: DataDef[] = [];

  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) throw new Error('Index rebuild aborted');
    const abs = files[i];
    const rel = path.relative(input.dataRoot, abs).replaceAll('\\', '/');
    const parsed = parsePath(rel);
    if (!parsed) continue;
    let content: string;
    try {
      content = await fsp.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    batch.push({
      pack: parsed.pack,
      defType: parsed.defType,
      defName: parsed.defName,
      label: parsed.label,
      description: parsed.description,
      filePath: rel,
      xml: content.length > MAX_STORED ? content.slice(0, MAX_STORED) : content,
    });
    if (batch.length >= 500) {
      insertBatch(batch);
      defCount += batch.length;
      batch.length = 0;
    }
    if (i % 1000 === 0) {
      onProgress({
        type: 'phase',
        phase: 'defs',
        message: `Indexing Minecraft data… ${i}/${files.length}`,
        fraction: files.length > 0 ? i / files.length : undefined,
      });
    }
  }
  if (batch.length > 0) {
    insertBatch(batch);
    defCount += batch.length;
  }

  onProgress({
    type: 'phase',
    phase: 'defs',
    message: `Indexed ${defCount} Minecraft data entries`,
    fraction: 1,
  });
  return defCount;
}

/**
 * Map a `data/<ns>/<category>/<id...>.json` or `assets/<ns>/<category>/<id...>.json`
 * path to a def identity. Returns null for files that don't fit (pack.mcmeta,
 * loose top-level files).
 */
function parsePath(
  rel: string,
): { pack: string; defType: string; defName: string; label: string; description: string } | null {
  const parts = rel.split('/');
  // [root, ns, category, ...idPath, name.json] — need at least 4 segments.
  if (parts.length < 4) return null;
  const ns = parts[1];
  const category = parts[2];
  const idPath = parts.slice(3).join('/').replace(/\.json$/i, '');
  if (!ns || !category || !idPath) return null;
  const defName = `${ns}:${idPath}`;
  const label = idPath.split('/').pop() ?? idPath;
  return { pack: ns, defType: category, defName, label, description: category };
}

async function listJsonFiles(root: string): Promise<string[]> {
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
      else if (e.isFile() && abs.toLowerCase().endsWith('.json')) out.push(abs);
    }
  }
  return out;
}
