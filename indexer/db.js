'use strict';

const { DatabaseSync } = require('node:sqlite');
const { existsSync } = require('fs');
const { dirname } = require('path');

function openDb(path) {
  path = path || process.env.DB_PATH || '/messier/.config/index.db';

  const parent = dirname(path);
  const root   = dirname(parent);
  if (!existsSync(root)) {
    throw new Error(`Fatal: ${root} does not exist. Is the ZFS pool mounted?`);
  }
  if (!existsSync(parent)) {
    throw new Error(`Fatal: ${parent} does not exist. Create it first: mkdir -p ${parent}`);
  }

  const db = new DatabaseSync(path);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = -262144;
    PRAGMA temp_store = MEMORY;
    PRAGMA mmap_size = 2147483648;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS datasets (
      id          INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL UNIQUE,
      pool        TEXT    NOT NULL,
      mountpoint  TEXT,
      created_at  INTEGER
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id                INTEGER PRIMARY KEY,
      dataset_id        INTEGER NOT NULL REFERENCES datasets(id),
      name              TEXT    NOT NULL,
      full_name         TEXT    NOT NULL UNIQUE,
      created_at        INTEGER NOT NULL,
      used_bytes        INTEGER,
      referenced_bytes  INTEGER,
      indexed_at        INTEGER,
      diff_done         INTEGER DEFAULT 0,
      UNIQUE(dataset_id, name)
    );

    CREATE TABLE IF NOT EXISTS files (
      id                  INTEGER PRIMARY KEY,
      dataset_id          INTEGER NOT NULL REFERENCES datasets(id),
      path                TEXT    NOT NULL,
      inode               INTEGER,
      type                TEXT    NOT NULL CHECK(type IN ('file','dir','link','other')),
      first_seen_snap_id  INTEGER REFERENCES snapshots(id),
      last_seen_snap_id   INTEGER REFERENCES snapshots(id),
      deleted_at_snap_id  INTEGER REFERENCES snapshots(id),
      UNIQUE(dataset_id, path)
    );

    CREATE TABLE IF NOT EXISTS file_versions (
      id           INTEGER PRIMARY KEY,
      file_id      INTEGER NOT NULL REFERENCES files(id),
      snapshot_id  INTEGER NOT NULL REFERENCES snapshots(id),
      size         INTEGER NOT NULL DEFAULT 0,
      mtime        INTEGER,
      ctime        INTEGER,
      nlink        INTEGER,
      mode         TEXT,
      UNIQUE(file_id, snapshot_id)
    );

    CREATE TABLE IF NOT EXISTS changes (
      id           INTEGER PRIMARY KEY,
      snapshot_id  INTEGER NOT NULL REFERENCES snapshots(id),
      file_id      INTEGER REFERENCES files(id),
      change_type  TEXT NOT NULL CHECK(change_type IN (
                     'added','removed','modified','renamed','unknown'
                   )),
      old_path     TEXT,
      new_path     TEXT,
      old_size     INTEGER,
      new_size     INTEGER,
      delta_bytes  INTEGER
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS fts_paths USING fts5(
      path,
      content=files,
      content_rowid=id,
      tokenize="unicode61 tokenchars './-_'"
    );

    -- FTS triggers are created on demand outside of bulk indexing.
    -- During bulk indexing they are dropped and FTS is rebuilt in one
    -- shot at the end via disableBulkMode() for dramatically less overhead.

    CREATE INDEX IF NOT EXISTS idx_fv_snapshot   ON file_versions(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_fv_file       ON file_versions(file_id);
    CREATE INDEX IF NOT EXISTS idx_fv_file_size  ON file_versions(file_id, snapshot_id DESC, size);
    CREATE INDEX IF NOT EXISTS idx_files_path    ON files(dataset_id, path);
    CREATE INDEX IF NOT EXISTS idx_files_dataset ON files(dataset_id, deleted_at_snap_id);
    CREATE INDEX IF NOT EXISTS idx_files_deleted ON files(deleted_at_snap_id);
    CREATE INDEX IF NOT EXISTS idx_changes_snap     ON changes(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_changes_file     ON changes(file_id, snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_changes_type     ON changes(change_type);
    CREATE INDEX IF NOT EXISTS idx_changes_old_path ON changes(old_path);
    CREATE INDEX IF NOT EXISTS idx_changes_new_path ON changes(new_path);
    CREATE INDEX IF NOT EXISTS idx_snap_dataset     ON snapshots(dataset_id, created_at);

    CREATE VIEW IF NOT EXISTS v_live_files AS
    SELECT
      f.id          AS file_id,
      d.name        AS dataset,
      f.path,
      f.type,
      fv.size,
      fv.mtime,
      s.name        AS snapshot_name,
      s.created_at  AS snapshot_created_at
    FROM files f
    JOIN datasets d       ON d.id = f.dataset_id
    JOIN file_versions fv ON fv.file_id = f.id
      AND fv.id = (SELECT id FROM file_versions WHERE file_id = f.id ORDER BY snapshot_id DESC LIMIT 1)
    JOIN snapshots s      ON s.id = f.last_seen_snap_id
    WHERE f.deleted_at_snap_id IS NULL;

    CREATE VIEW IF NOT EXISTS v_deleted_files AS
    SELECT
      f.id          AS file_id,
      d.name        AS dataset,
      f.path        AS last_path,
      f.type,
      fv.size       AS last_size,
      s_last.name   AS last_seen_in,
      s_del.name    AS deleted_in,
      s_del.created_at AS deleted_at
    FROM files f
    JOIN datasets d       ON d.id = f.dataset_id
    JOIN file_versions fv ON fv.file_id = f.id
      AND fv.id = (SELECT id FROM file_versions WHERE file_id = f.id ORDER BY snapshot_id DESC LIMIT 1)
    JOIN snapshots s_last ON s_last.id = f.last_seen_snap_id
    JOIN snapshots s_del  ON s_del.id  = f.deleted_at_snap_id
    WHERE f.deleted_at_snap_id IS NOT NULL;
  `);

  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Drop FTS triggers for bulk indexing. We keep synchronous=NORMAL (the WAL
 * default) instead of OFF — the performance difference is negligible but
 * OFF risks full DB corruption on power loss, requiring a complete re-index.
 */
function enableBulkMode(db) {
  db.exec(`
    DROP TRIGGER IF EXISTS fts_paths_ai;
    DROP TRIGGER IF EXISTS fts_paths_ad;
    DROP TRIGGER IF EXISTS fts_paths_au;
  `);
}

/**
 * Checkpoint WAL to keep it from growing unboundedly during long runs.
 */
function checkpoint(db) {
  db.exec(`PRAGMA wal_checkpoint(PASSIVE)`);
}

/**
 * Rebuild FTS index from the files table in one shot, re-create triggers,
 * then checkpoint.
 */
function disableBulkMode(db) {
  console.log('  📇 Rebuilding FTS index...');
  const t = Date.now();
  db.exec(`
    INSERT INTO fts_paths(fts_paths) VALUES('delete-all');
    INSERT INTO fts_paths(rowid, path) SELECT id, path FROM files;
  `);
  console.log(`     FTS rebuilt in ${((Date.now() - t) / 1000).toFixed(1)}s`);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS fts_paths_ai AFTER INSERT ON files BEGIN
      INSERT INTO fts_paths(rowid, path) VALUES (new.id, new.path);
    END;
    CREATE TRIGGER IF NOT EXISTS fts_paths_ad AFTER DELETE ON files BEGIN
      INSERT INTO fts_paths(fts_paths, rowid, path) VALUES('delete', old.id, old.path);
    END;
    CREATE TRIGGER IF NOT EXISTS fts_paths_au AFTER UPDATE OF path ON files BEGIN
      INSERT INTO fts_paths(fts_paths, rowid, path) VALUES('delete', old.id, old.path);
      INSERT INTO fts_paths(rowid, path) VALUES (new.id, new.path);
    END;
  `);

  checkpoint(db);
}

module.exports = { openDb, transaction, enableBulkMode, disableBulkMode, checkpoint };
