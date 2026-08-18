import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'fs';
import os from 'os';
import path from 'path';

const INDEX_DB_DIR = '/messier/.config';
const INDEX_DB_NAME = 'index.db';
const INDEX_DB_PATH = path.join(INDEX_DB_DIR, INDEX_DB_NAME);
const POOL_MOUNT = path.dirname(INDEX_DB_DIR);

// Plain `unicode61`, so `/`, `.`, `-` and `_` all split tokens: `/data/invoice.pdf` indexes as
// `data`, `invoice`, `pdf`. Adding those to `tokenchars` (as this once did) made the whole path a
// single token, and no ordinary search term could ever match.
const FTS_TABLE_SQL = `
	CREATE VIRTUAL TABLE IF NOT EXISTS fts_paths USING fts5(
		path,
		content=files,
		content_rowid=id,
		tokenize="unicode61"
	);
`;

const FTS_TRIGGERS_SQL = `
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
`;

const DROP_FTS_TRIGGERS_SQL = `
	DROP TRIGGER IF EXISTS fts_paths_ai;
	DROP TRIGGER IF EXISTS fts_paths_ad;
	DROP TRIGGER IF EXISTS fts_paths_au;
`;

/**
 * Ordered schema migrations. `CREATE TABLE IF NOT EXISTS` cannot change an existing table, so
 * anything beyond adding a new table or index has to go here. The array index + 1 is the
 * `user_version` a database is at once that entry has run.
 */
const MIGRATIONS = [
	// 1 — rebuild fts_paths with the corrected tokenizer (see FTS_TABLE_SQL).
	(db) => {
		db.exec(`${DROP_FTS_TRIGGERS_SQL} DROP TABLE IF EXISTS fts_paths;`);
		db.exec(FTS_TABLE_SQL);
		rebuildFts(db);
		db.exec(FTS_TRIGGERS_SQL);
	},
	// 2 — record each change's own timestamp, which zfs diff always gave us.
	(db) => {
		addColumnIfMissing(db, 'changes', 'changed_at', 'INTEGER');
	},
];

/**
 * Migrations run after the CREATE TABLE IF NOT EXISTS block, so a table that
 * happened to be created by this run already carries the new column and a plain
 * ALTER would throw and abort open().
 */
function addColumnIfMissing(db, table, column, declaration) {
	const present = db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?`).get(table, column).n;
	if (!present) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
	}
}

function migrate(db, isFreshDatabase) {
	// A database created by this build already has the current schema; stamping it
	// skips a pointless drop-and-rebuild of an empty FTS index on every new install.
	if (isFreshDatabase) {
		db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
		return;
	}
	const from = db.prepare('PRAGMA user_version').get().user_version ?? 0;
	if (from >= MIGRATIONS.length) {
		return;
	}
	for (let v = from; v < MIGRATIONS.length; v++) {
		console.log(`  ⤴  Migrating index schema to v${v + 1}…`);
		MIGRATIONS[v](db);
		db.exec(`PRAGMA user_version = ${v + 1}`);
	}
}

// A file of the right name would satisfy a plain existence check and then fail inside SQLite, so what
// is asked is whether the path is a directory at all.
const isDirectory = (target) => {
	try {
		return statSync(target).isDirectory();
	} catch (error) {
		return false;
	}
};

/** Returns null when there is nowhere to keep an index — no pool, or a pool setup has not prepared
 * yet. Nothing has been indexed in that state, so callers report that rather than failing. */
function open(dbPath = null) {
	if (!dbPath) {
		if (!isDirectory(POOL_MOUNT) || !isDirectory(INDEX_DB_DIR)) {
			return null;
		}
		dbPath = INDEX_DB_PATH;
	}

	const db = new DatabaseSync(dbPath);

	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA synchronous = NORMAL;
		PRAGMA busy_timeout = 5000;
		PRAGMA temp_store = MEMORY;
	`);

	// Scaled to the box rather than fixed: the previous 256 MiB page cache plus a
	// 2 GiB mmap window is most of RAM on the Pi-class hardware this runs on, and
	// the crawl needs room of its own.
	const totalMemory = os.totalmem();
	const cacheKiB = Math.max(16 * 1024, Math.min(256 * 1024, Math.floor(totalMemory * 0.08 / 1024)));
	const mmapBytes = Math.max(256 * 1024 ** 2, Math.min(2 * 1024 ** 3, Math.floor(totalMemory * 0.25)));
	db.exec(`
		PRAGMA cache_size = -${cacheKiB};
		PRAGMA mmap_size = ${mmapBytes};
	`);

	const isFreshDatabase = !db.prepare(
		`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'files'`
	).get().n;

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

		CREATE TABLE IF NOT EXISTS meta (
			key   TEXT PRIMARY KEY NOT NULL,
			value TEXT NOT NULL
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
			delta_bytes  INTEGER,
			-- From zfs diff -FHt: when the change actually happened, which is
			-- finer grained than the snapshot's own timestamp.
			changed_at   INTEGER
		);

		${FTS_TABLE_SQL}

		-- FTS triggers are created on demand outside of bulk indexing.
		-- During bulk indexing they are dropped and FTS is rebuilt in one
		-- shot at the end via disableBulkMode() for dramatically less overhead.

		-- idx_fv_file(file_id) is a prefix of idx_fv_file_size, idx_files_path
		-- duplicates the implicit UNIQUE(dataset_id, path) index, and
		-- idx_files_deleted is covered by idx_files_dataset for every query we
		-- issue. Each one only cost write throughput and space on a full crawl.
		CREATE INDEX IF NOT EXISTS idx_fv_snapshot ON file_versions(snapshot_id);
		CREATE INDEX IF NOT EXISTS idx_fv_file_size ON file_versions(file_id, snapshot_id DESC, size);
		CREATE INDEX IF NOT EXISTS idx_files_dataset ON files(dataset_id, deleted_at_snap_id);
		DROP INDEX IF EXISTS idx_fv_file;
		DROP INDEX IF EXISTS idx_files_path;
		DROP INDEX IF EXISTS idx_files_deleted;
		CREATE INDEX IF NOT EXISTS idx_changes_snap ON changes(snapshot_id);
		CREATE INDEX IF NOT EXISTS idx_changes_file ON changes(file_id, snapshot_id);
		CREATE INDEX IF NOT EXISTS idx_changes_type ON changes(change_type);
		CREATE INDEX IF NOT EXISTS idx_changes_old_path ON changes(old_path);
		CREATE INDEX IF NOT EXISTS idx_changes_new_path ON changes(new_path);
		CREATE INDEX IF NOT EXISTS idx_snap_dataset ON snapshots(dataset_id, created_at);

		CREATE VIEW IF NOT EXISTS v_live_files AS
		SELECT
			f.id AS file_id,
			d.name AS dataset,
			f.path,
			f.type,
			fv.size,
			fv.mtime,
			s.name AS snapshot_name,
			s.created_at AS snapshot_created_at
		FROM files f
		JOIN datasets d ON d.id = f.dataset_id
		JOIN file_versions fv ON fv.file_id = f.id
			AND fv.id = (SELECT id FROM file_versions WHERE file_id = f.id ORDER BY snapshot_id DESC LIMIT 1)
		JOIN snapshots s ON s.id = f.last_seen_snap_id
		WHERE f.deleted_at_snap_id IS NULL;

		CREATE VIEW IF NOT EXISTS v_deleted_files AS
		SELECT
			f.id AS file_id,
			d.name AS dataset,
			f.path AS last_path,
			f.type,
			fv.size AS last_size,
			s_last.name AS last_seen_in,
			s_del.name AS deleted_in,
			s_del.created_at AS deleted_at
		FROM files f
		JOIN datasets d ON d.id = f.dataset_id
		JOIN file_versions fv ON fv.file_id = f.id
			AND fv.id = (SELECT id FROM file_versions WHERE file_id = f.id ORDER BY snapshot_id DESC LIMIT 1)
		JOIN snapshots s_last ON s_last.id = f.last_seen_snap_id
		JOIN snapshots s_del ON s_del.id = f.deleted_at_snap_id
		WHERE f.deleted_at_snap_id IS NOT NULL;
	`);

	migrate(db, isFreshDatabase);

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
	db.exec(DROP_FTS_TRIGGERS_SQL);
}

/**
 * Checkpoint WAL to keep it from growing unboundedly during long runs.
 */
function checkpoint(db) {
	db.exec(`PRAGMA wal_checkpoint(PASSIVE)`);
}

// Retention pruning frees a lot of pages at once and SQLite never hands them back
// on its own, so the file only ever grows. Rewriting is expensive and needs room
// for a second copy, so only do it when there is real slack to reclaim.
const VACUUM_FREE_RATIO = 0.3;
const VACUUM_MIN_FREE_BYTES = 256 * 1024 ** 2;

function vacuumIfBloated(db) {
	const pageSize = db.prepare('PRAGMA page_size').get().page_size;
	const pageCount = db.prepare('PRAGMA page_count').get().page_count;
	const freeCount = db.prepare('PRAGMA freelist_count').get().freelist_count;
	if (!pageCount || !freeCount) {
		return false;
	}
	const freeBytes = freeCount * pageSize;
	if (freeCount / pageCount < VACUUM_FREE_RATIO || freeBytes < VACUUM_MIN_FREE_BYTES) {
		return false;
	}
	console.log(`  🧽 Reclaiming ${(freeBytes / 1024 ** 3).toFixed(2)}G of free pages (VACUUM)…`);
	const t = Date.now();
	try {
		db.exec('VACUUM');
	} catch (e) {
		console.warn(`  ⚠  VACUUM failed: ${e.message}`);
		return false;
	}
	console.log(`     Done in ${((Date.now() - t) / 1000).toFixed(1)}s`);
	return true;
}

/** One transaction, or readers see an empty FTS index for the whole rebuild. */
function rebuildFts(db) {
	transaction(db, () => {
		db.exec(`
			INSERT INTO fts_paths(fts_paths) VALUES('delete-all');
			INSERT INTO fts_paths(rowid, path) SELECT id, path FROM files;
			INSERT INTO fts_paths(fts_paths) VALUES('optimize');
		`);
	});
}

/**
 * Rebuild FTS index from the files table in one shot, re-create triggers,
 * then checkpoint.
 */
function disableBulkMode(db) {
	console.log('  📇 Rebuilding FTS index...');
	const t = Date.now();
	rebuildFts(db);
	console.log(`     FTS rebuilt in ${((Date.now() - t) / 1000).toFixed(1)}s`);

	db.exec(FTS_TRIGGERS_SQL);

	checkpoint(db);
}

export { INDEX_DB_DIR, INDEX_DB_NAME, INDEX_DB_PATH, open, transaction, enableBulkMode, disableBulkMode, checkpoint, vacuumIfBloated };
