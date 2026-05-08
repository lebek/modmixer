import path from 'node:path';
import type Database from 'better-sqlite3';
import { getIndexPaths } from './paths.js';

/**
 * Resolve and require better-sqlite3. We can't let Vite bundle it (native
 * binding), and Forge ships it as an extraResource in packaged builds.
 *
 * `app.isPackaged` is unreliable here because `electron-forge start` bundles
 * to .vite/build and the resulting process reports as packaged depending on
 * how Forge invokes Electron. So: try a normal require first (which works
 * in dev, where node_modules is on disk), and fall back to resourcesPath
 * only if that fails (the packaged-app case where node_modules was stripped).
 */
function loadBetterSqlite(): typeof Database {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('better-sqlite3') as typeof Database;
  } catch (devErr) {
    try {
      const resolved = path.join(process.resourcesPath, 'better-sqlite3');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require(resolved) as typeof Database;
    } catch (prodErr) {
      // Surface whichever error is more informative — the packaged path is
      // usually the one that fails when something is genuinely broken.
      throw prodErr instanceof Error ? prodErr : devErr;
    }
  }
}

let cached: Database.Database | null = null;

export function openIndexDb(): Database.Database {
  if (cached) return cached;
  const Sqlite = loadBetterSqlite();
  const { dbPath } = getIndexPaths();
  cached = new Sqlite(dbPath);
  cached.pragma('journal_mode = WAL');
  cached.pragma('synchronous = NORMAL');
  ensureSchema(cached);
  return cached;
}

export function closeIndexDb(): void {
  if (cached) {
    try {
      cached.close();
    } catch {
      // ignore — process exit will release the handle anyway
    }
    cached = null;
  }
}

/**
 * Drop everything and recreate. Called by the rebuilder before populating
 * fresh data so we don't have to think about partial-state UPSERTs.
 */
export function resetSchema(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS def_fts;
    DROP TABLE IF EXISTS def_reference;
    DROP TABLE IF EXISTS symbol;
    DROP TABLE IF EXISTS def;
  `);
  ensureSchema(db);
}

function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS def (
      -- Synthetic rowid so FTS5 content='def' aligns with our INSERT order.
      -- Real uniqueness is handled by resetSchema() wiping the table before
      -- each rebuild, so we don't need a (pack, defType, defName) primary key.
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      pack         TEXT NOT NULL,
      defType      TEXT NOT NULL,
      defName      TEXT,
      inheritName  TEXT,
      parentName   TEXT,
      abstract     INTEGER NOT NULL,
      label        TEXT,
      description  TEXT,
      filePath     TEXT NOT NULL,
      startLine    INTEGER,
      xml          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_def_name ON def(defName);
    CREATE INDEX IF NOT EXISTS idx_def_inherit ON def(inheritName);
    CREATE INDEX IF NOT EXISTS idx_def_type ON def(defType);
    CREATE INDEX IF NOT EXISTS idx_def_parent ON def(parentName);

    -- External-content FTS5 over the def table. content_rowid='id' ties
    -- each FTS row to the corresponding def.id; the indexer inserts rows
    -- using the same rowid via last_insert_rowid().
    CREATE VIRTUAL TABLE IF NOT EXISTS def_fts USING fts5(
      defName, label, description,
      content='def',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS symbol (
      fqn          TEXT NOT NULL,
      shortName    TEXT NOT NULL,
      kind         TEXT NOT NULL,
      parentFqn    TEXT,
      filePath     TEXT NOT NULL,
      startLine    INTEGER NOT NULL,
      endLine      INTEGER NOT NULL,
      signature    TEXT,
      -- startLine in the PK so method overloads (same fqn, same file,
      -- different lines) don't get clobbered by INSERT OR REPLACE during
      -- indexing.
      PRIMARY KEY (fqn, filePath, startLine)
    );
    CREATE INDEX IF NOT EXISTS idx_symbol_short ON symbol(shortName);
    CREATE INDEX IF NOT EXISTS idx_symbol_parent ON symbol(parentFqn);

    CREATE TABLE IF NOT EXISTS def_reference (
      defName    TEXT NOT NULL,
      filePath   TEXT NOT NULL,
      line       INTEGER NOT NULL,
      PRIMARY KEY (defName, filePath, line)
    );
    CREATE INDEX IF NOT EXISTS idx_defref_name ON def_reference(defName);
  `);
}
