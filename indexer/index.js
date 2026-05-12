'use strict';

const DataService = require('../src/database/data_service');
const { INDEX_DB_PATH, openDb, transaction, enableBulkMode, disableBulkMode, checkpoint } = require('./db');
const { discoverAll, diffSnapshots, snapshotMountPath, isZfsDiffFailure } = require('./zfs');
const { walkSnapshot } = require('./walker');
const { formatSize, formatDuration, acquireLock, releaseLock } = require('./utils');
const { execaSync } = require('execa');
const { stat } = require('fs/promises');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function umountSnapshot(snapPath) {
	try {
		execaSync('umount', [snapPath]);
	} catch {
		/* ignore */
	}
}

async function safeStatAsync(path) {
	try {
		return await stat(path);
	} catch {
		return null;
	}
}

async function batchStat(entries, concurrency = 64) {
	const results = new Array(entries.length);
	for (let i = 0; i < entries.length; i += concurrency) {
		const slice = entries.slice(i, i + concurrency);
		const stats = await Promise.all(slice.map(e => safeStatAsync(e.fullPath)));
		for (let j = 0; j < slice.length; j++) {
			results[i + j] = stats[j];
		}
	}
	return results;
}

function restartIndexerFromBeginning(message) {
	const e = new Error(message);
	e.code = 'INDEXER_RESTART_FROM_BEGINNING';
	throw e;
}

function cleanupPartialDiffWork(db, stmt, snapId, datasetId, mode) {
	transaction(db, () => {
		stmt.deleteChangesBySnapshot.run(snapId);
		if (mode === 'changes_only') {
			stmt.clearDeletedAt.run(snapId);
			return;
		}
		stmt.deleteVersionsBySnapshot.run(snapId);
		stmt.clearFirstSeen.run(snapId);
		stmt.clearLastSeen.run(snapId);
		stmt.clearDeletedAt.run(snapId);
		stmt.repairLastSeenNull.run(datasetId);
		stmt.repairFirstSeenNull.run(datasetId);
		stmt.deleteChangesForOrphanedFiles.run();
		stmt.deleteOrphanedFiles.run();
	});
}

function datasetInIncludeScope(name, includeDatasets) {
	return includeDatasets.some(p => name === p || name.startsWith(p + '/'));
}

function prepareDatasetPruneStatements(db) {
	return {
		deleteChangesForDataset: db.prepare(`
			DELETE FROM changes WHERE snapshot_id IN (SELECT id FROM snapshots WHERE dataset_id = ?)
		`),
		deleteFileVersionsForDataset: db.prepare(`
			DELETE FROM file_versions WHERE file_id IN (SELECT id FROM files WHERE dataset_id = ?)
		`),
		deleteFilesForDataset: db.prepare(`DELETE FROM files WHERE dataset_id = ?`),
		deleteSnapshotsForDataset: db.prepare(`DELETE FROM snapshots WHERE dataset_id = ?`),
		deleteDatasetById: db.prepare(`DELETE FROM datasets WHERE id = ?`),
	};
}

/**
 * Remove SQLite rows for datasets that are no longer indexed:
 * - name not under current Configuration `indexer` list, or
 * - still in scope but not returned by ZFS this run (dataset destroyed / renamed away).
 */
function pruneStaleIndexedDatasets(db, stmt, includeDatasets, liveNames) {
	const rows = db.prepare('SELECT id, name FROM datasets').all();
	for (const { id, name } of rows) {
		const inScope = datasetInIncludeScope(name, includeDatasets);
		const onZfs = liveNames.has(name);
		if (inScope && onZfs) {
			continue;
		}
		const reason = !inScope ? 'removed from indexer configuration' : 'no longer present on ZFS';
		console.log(`  🗑  Dropping index data for ${name} (${reason})`);
		transaction(db, () => {
			stmt.deleteChangesForDataset.run(id);
			stmt.deleteFileVersionsForDataset.run(id);
			stmt.deleteFilesForDataset.run(id);
			stmt.deleteSnapshotsForDataset.run(id);
			stmt.deleteDatasetById.run(id);
		});
	}
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function normalizeIndexerDatasets(configuration) {
	const raw = configuration?.indexer;
	if (raw === null || raw === undefined) {
		return [];
	}
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.map(s => String(s).trim()).filter(Boolean);
}

async function run(_opts = {}) {
	const configuration = await DataService.getConfiguration();
	const includeDatasets = normalizeIndexerDatasets(configuration);

	if (!includeDatasets.length) {
		console.log(
			'Indexer: Configuration key `indexer` is missing, empty, or not a JSON array (virgo.db); clearing the index database.'
		);
		const lockPath = acquireLock(INDEX_DB_PATH);
		try {
			const db = openDb();
			try {
				const stmt = prepareDatasetPruneStatements(db);
				pruneStaleIndexedDatasets(db, stmt, [], new Set());
				disableBulkMode(db);
				const lastRunAt = new Date().toISOString();
				transaction(db, () => {
					db.prepare(`
						INSERT INTO meta(key, value) VALUES ('last_run_at', ?)
						ON CONFLICT(key) DO UPDATE SET value = excluded.value
					`).run(lastRunAt);
				});
				console.log('✅ Index database cleared (no indexer roots configured).');
			} finally {
				try {
					db.exec('PRAGMA optimize');
				} catch {
					/* ignore */
				}
				db.close();
			}
		} finally {
			releaseLock(lockPath);
		}
		return;
	}

	const lockPath = acquireLock(INDEX_DB_PATH);
	try {
		const maxRestarts = Number.parseInt(process.env.INDEXER_MAX_DIFF_RESTARTS ?? '10', 10);
		const maxAttempts = Math.max(1, maxRestarts + 1);
		const sessionWallT0 = Date.now();

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (attempt > 0) {
				console.log(`\n↻ Restarting indexer from the beginning (attempt ${attempt + 1}/${maxAttempts})…\n`);
			}
			try {
				await runIndexerPass(includeDatasets, sessionWallT0, attempt, lockPath);
				return;
			} catch (e) {
				if (e.code !== 'INDEXER_RESTART_FROM_BEGINNING') {
					throw e;
				}
				if (attempt + 1 >= maxAttempts) {
					console.error(`Fatal: zfs diff still failing after ${maxAttempts} full restarts.`);
					process.exitCode = 1;
					throw e;
				}
			}
		}
	} finally {
		releaseLock(lockPath);
	}
}

async function runIndexerPass(includeDatasets, sessionWallT0 = null, restartCount = 0, lockPath = null) {
	const pool = includeDatasets[0].split('/')[0];

	const db = openDb();

	const perf = {
		t0: Date.now(), snapsCrawled: 0, snapsIncremental: 0, snapsSkipped: 0,
		diffsDone: 0, filesCrawled: 0, crawlMs: 0, diffMs: 0,
		sqlInserts: 0, sqlUpserts: 0, sqlSelects: 0, sqlUpdates: 0, sqlTxns: 0, sqlMs: 0,
		diffChanges: 0, statMs: 0,
	};

	// ── Prepared statements ──
	const stmt = {
		upsertDataset: db.prepare(`INSERT INTO datasets(name, pool, mountpoint, created_at) VALUES(?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET mountpoint=excluded.mountpoint RETURNING id`),
		upsertSnapshot: db.prepare(`INSERT INTO snapshots(dataset_id, name, full_name, created_at, used_bytes, referenced_bytes) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(full_name) DO UPDATE SET used_bytes=excluded.used_bytes RETURNING id`),
		getSnapshotByFullName: db.prepare(`SELECT id FROM snapshots WHERE full_name=?`),
		getSnapshotsForDataset: db.prepare(`SELECT id, name, full_name, created_at, indexed_at, diff_done FROM snapshots WHERE dataset_id=? ORDER BY created_at ASC`),
		markIndexed: db.prepare(`UPDATE snapshots SET indexed_at=? WHERE id=?`),
		markDiffDone: db.prepare(`UPDATE snapshots SET diff_done=1 WHERE id=?`),
		upsertFile: db.prepare(`INSERT INTO files(dataset_id, path, inode, type, first_seen_snap_id, last_seen_snap_id) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(dataset_id, path) DO UPDATE SET inode=excluded.inode, type=excluded.type, last_seen_snap_id=excluded.last_seen_snap_id, deleted_at_snap_id=NULL RETURNING id`),
		insertVersion: db.prepare(`INSERT OR IGNORE INTO file_versions(file_id, snapshot_id, size, mtime, ctime, nlink, mode) VALUES(?, ?, ?, ?, ?, ?, ?)`),
		getFileByPath: db.prepare(`SELECT id FROM files WHERE dataset_id = ? AND path = ?`),
		getLatestSize: db.prepare(`SELECT size FROM file_versions WHERE file_id = ? ORDER BY snapshot_id DESC LIMIT 1`),
		getSizeAtSnapshot: db.prepare(`SELECT size FROM file_versions WHERE file_id = ? AND snapshot_id = ? LIMIT 1`),
		getSizeByPathAtSnapshot: db.prepare(`SELECT fv.size FROM file_versions fv JOIN files f ON f.id = fv.file_id WHERE f.dataset_id = ? AND f.path = ? AND fv.snapshot_id = ? LIMIT 1`),
		markDeleted: db.prepare(`UPDATE files SET deleted_at_snap_id = ? WHERE id = ? AND deleted_at_snap_id IS NULL`),
		updateFileRename: db.prepare(`
			UPDATE files SET path = ?, inode = ?, type = ?, last_seen_snap_id = ?, deleted_at_snap_id = NULL
			WHERE id = ? AND dataset_id = ?
		`),
		deleteChangesByFileId: db.prepare(`DELETE FROM changes WHERE file_id = ?`),
		deleteVersionsByFileId: db.prepare(`DELETE FROM file_versions WHERE file_id = ?`),
		deleteFileById: db.prepare(`DELETE FROM files WHERE id = ?`),
		insertChange: db.prepare(`INSERT INTO changes(snapshot_id, file_id, change_type, old_path, new_path, old_size, new_size, delta_bytes) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`),
		bumpLastSeen: db.prepare(`UPDATE files SET last_seen_snap_id = ? WHERE dataset_id = ? AND deleted_at_snap_id IS NULL`),
		deleteChangesBySnapshot: db.prepare(`DELETE FROM changes WHERE snapshot_id = ?`),
		deleteVersionsBySnapshot: db.prepare(`DELETE FROM file_versions WHERE snapshot_id = ?`),
		clearFirstSeen: db.prepare(`UPDATE files SET first_seen_snap_id = NULL WHERE first_seen_snap_id = ?`),
		clearLastSeen: db.prepare(`UPDATE files SET last_seen_snap_id = NULL WHERE last_seen_snap_id = ?`),
		clearDeletedAt: db.prepare(`UPDATE files SET deleted_at_snap_id = NULL WHERE deleted_at_snap_id = ?`),
		deleteSnapshot: db.prepare(`DELETE FROM snapshots WHERE id = ?`),
		...prepareDatasetPruneStatements(db),
		deleteChangesForOrphanedFiles: db.prepare(`
			DELETE FROM changes WHERE file_id IN (
				SELECT f.id FROM files f
				WHERE NOT EXISTS (SELECT 1 FROM file_versions fv WHERE fv.file_id = f.id)
			)
		`),
		deleteOrphanedFiles: db.prepare(`
			DELETE FROM files WHERE NOT EXISTS (
				SELECT 1 FROM file_versions fv WHERE fv.file_id = files.id
			)
		`),
		repairLastSeenNull: db.prepare(`
			UPDATE files SET last_seen_snap_id = (
				SELECT snapshot_id FROM file_versions WHERE file_id = files.id
				ORDER BY snapshot_id DESC LIMIT 1
			)
			WHERE dataset_id = ?
			AND last_seen_snap_id IS NULL
			AND EXISTS (SELECT 1 FROM file_versions WHERE file_id = files.id)
		`),
		repairFirstSeenNull: db.prepare(`
			UPDATE files SET first_seen_snap_id = (
				SELECT MIN(snapshot_id) FROM file_versions WHERE file_id = files.id
			)
			WHERE dataset_id = ?
			AND first_seen_snap_id IS NULL
			AND EXISTS (SELECT 1 FROM file_versions WHERE file_id = files.id)
		`),
		setMeta: db.prepare(`
			INSERT INTO meta(key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`),
	};

	let inBulkMode = false;
	const onSignal = (sig) => {
		console.log(`\n⚠  Received ${sig} during indexing, restoring DB state…`);
		if (inBulkMode) {
			try {
				disableBulkMode(db);
			} catch {
				/* ignore */
			}
		}
		try {
			db.exec('PRAGMA optimize');
		} catch {
			/* ignore */
		}
		try {
			db.close();
		} catch {
			/* ignore */
		}
		if (lockPath) {
			releaseLock(lockPath);
		}
		process.exit(sig === 'SIGTERM' ? 143 : 130);
	};
	process.on('SIGTERM', onSignal);
	process.on('SIGINT', onSignal);

	try {
		console.log('🔍 Discovering ZFS datasets and snapshots...');
		console.log(`   Pool: ${pool}`);
		console.log(`   Include: ${includeDatasets.join(', ')}`);

		const { datasets, snapshots } = discoverAll({ pool });
		// Pool-wide discovery; keep only configured roots and their descendants.
		const filteredDatasets = datasets.filter(d =>
			includeDatasets.some(p => d.name === p || d.name.startsWith(p + '/'))
		);
		const liveDatasetNames = new Set(filteredDatasets.map(d => d.name));
		pruneStaleIndexedDatasets(db, stmt, includeDatasets, liveDatasetNames);

		if (!filteredDatasets.length) {
			console.log('No datasets matched the filter.');
			return;
		}

		const datasetIds = {};
		for (const d of filteredDatasets) {
			const row = stmt.upsertDataset.get(d.name, d.pool, d.mountpoint, d.created_at);
			datasetIds[d.name] = row.id;
			console.log(`  Dataset: ${d.name} (id=${row.id})`);
		}

		const snapshotIds = {};
		for (const s of snapshots) {
			const dsId = datasetIds[s.dataset_name];
			if (!dsId) {
				continue;
			}
			const row = stmt.upsertSnapshot.get(dsId, s.name, s.full_name, s.created_at, s.used_bytes, s.referenced_bytes);
			if (row) { snapshotIds[s.full_name] = row.id; }
			else {
				const existing = stmt.getSnapshotByFullName.get(s.full_name);
				if (existing) {
					snapshotIds[s.full_name] = existing.id;
				}
			}
		}

		// Prune deleted snapshots
		const liveFullNames = new Set(snapshots.map(s => s.full_name));
		for (const d of filteredDatasets) {
			const dsId = datasetIds[d.name];
			for (const snap of stmt.getSnapshotsForDataset.all(dsId)) {
				if (!liveFullNames.has(snap.full_name)) {
					console.log(`  🗑  Pruning: ${snap.full_name}`);
					transaction(db, () => {
						stmt.deleteChangesBySnapshot.run(snap.id);
						stmt.deleteVersionsBySnapshot.run(snap.id);
						stmt.clearFirstSeen.run(snap.id);
						stmt.clearLastSeen.run(snap.id);
						stmt.clearDeletedAt.run(snap.id);
						stmt.deleteSnapshot.run(snap.id);
					});
				}
			}
		}
		transaction(db, () => {
			for (const d of filteredDatasets) {
				const dsId = datasetIds[d.name];
				stmt.repairLastSeenNull.run(dsId);
				stmt.repairFirstSeenNull.run(dsId);
			}
			stmt.deleteChangesForOrphanedFiles.run();
			stmt.deleteOrphanedFiles.run();
		});

		enableBulkMode(db);
		inBulkMode = true;

		transaction(db, () => {
			stmt.setMeta.run('last_activity_at', new Date().toISOString());
		});

		for (const d of filteredDatasets) {
			const dsId = datasetIds[d.name];
			const dsSnaps = stmt.getSnapshotsForDataset.all(dsId);
			console.log(`\n📦 Dataset: ${d.name} (${dsSnaps.length} snapshots)`);

			const lastIncrSnapId = findLastIncrementalSnapId(dsSnaps);

			let prevSnap = null;
			let snapIdx = 0;
			for (const snap of dsSnaps) {
				const snapPath = snapshotMountPath(d.mountpoint, snap.name);

				const needIndex = !snap.indexed_at;
				const needDiff = prevSnap && !snap.diff_done;
				const canIncremental = needIndex && prevSnap && prevSnap.indexed_at;

				if (needIndex) {
					if (!snapPath) {
						prevSnap = snap;
						continue;
					}

					if (canIncremental && needDiff) {
						const t = Date.now();
						try {
							await doIncrementalUnified(db, stmt, perf, prevSnap, snap, dsId, d.mountpoint, snapPath);
						} catch (e) {
							if (!isZfsDiffFailure(e)) {
								throw e;
							}
							console.warn(`  ⚠  zfs diff failed (${prevSnap.name} → ${snap.name}): ${e.message}`);
							console.log('  🧹 Cleaning up partial index/diff rows for this snapshot…');
							cleanupPartialDiffWork(db, stmt, snap.id, dsId, 'incremental');
							restartIndexerFromBeginning(
								`zfs diff failed; restarting from beginning so retention/deleted snapshots are re-discovered.`
							);
						}
						perf.crawlMs += Date.now() - t;
						perf.snapsIncremental++;
						perf.diffsDone++;
						stmt.markDiffDone.run(snap.id);
					} else if (canIncremental) {
						const t = Date.now();
						try {
							await doIncremental(db, stmt, perf, prevSnap, snap, dsId, d.mountpoint, snapPath);
						} catch (e) {
							if (!isZfsDiffFailure(e)) {
								throw e;
							}
							console.warn(`  ⚠  zfs diff failed (${prevSnap.name} → ${snap.name}): ${e.message}`);
							console.log('  🧹 Cleaning up partial index rows for this snapshot…');
							cleanupPartialDiffWork(db, stmt, snap.id, dsId, 'incremental');
							restartIndexerFromBeginning(
								`zfs diff failed; restarting from beginning so retention/deleted snapshots are re-discovered.`
							);
						}
						perf.crawlMs += Date.now() - t;
						perf.snapsIncremental++;
					} else {
						const t = Date.now();
						const count = await doCrawl(db, stmt, perf, snap.id, dsId, snapPath, snap.full_name);
						perf.crawlMs += Date.now() - t;
						perf.snapsCrawled++;
						perf.filesCrawled += count;
					}

					stmt.markIndexed.run(Date.now() / 1000 | 0, snap.id);
					snap.indexed_at = 1;
					umountSnapshot(snapPath);
				} else {
					perf.snapsSkipped++;
					console.log(`  ✓  ${snap.name} already indexed`);
				}

				if (needDiff && !canIncremental) {
					if (prevSnap) {
						console.log(`  ↔️  diff ${prevSnap.name} → ${snap.name}`);
						const t = Date.now();
						try {
							await doDiff(db, stmt, perf, prevSnap, snap, dsId, d.mountpoint);
						} catch (e) {
							if (!isZfsDiffFailure(e)) {
								throw e;
							}
							console.warn(`  ⚠  zfs diff failed (${prevSnap.name} → ${snap.name}): ${e.message}`);
							console.log('  🧹 Cleaning up partial change rows for this snapshot…');
							cleanupPartialDiffWork(db, stmt, snap.id, dsId, 'changes_only');
							restartIndexerFromBeginning(
								`zfs diff failed; restarting from beginning so retention/deleted snapshots are re-discovered.`
							);
						}
						perf.diffMs += Date.now() - t;
						perf.diffsDone++;
						stmt.markDiffDone.run(snap.id);
					}
				}

				prevSnap = snap;
				snapIdx++;

				if (snapIdx % 10 === 0) {
					checkpoint(db);
					transaction(db, () => {
						stmt.setMeta.run('last_activity_at', new Date().toISOString());
					});
				}
			}

			if (lastIncrSnapId !== null && lastIncrSnapId !== undefined) {
				const t = Date.now();
				stmt.bumpLastSeen.run(lastIncrSnapId, dsId);
				perf.sqlUpdates++;
				perf.sqlMs += Date.now() - t;
			}
		}

		disableBulkMode(db);
		inBulkMode = false;

		const lastRunAt = new Date().toISOString();
		transaction(db, () => {
			db.prepare(`
				INSERT INTO meta(key, value) VALUES ('last_run_at', ?)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value
			`).run(lastRunAt);
		});

		console.log('\n✅ Indexing complete.');
		printStats(db, perf, sessionWallT0, restartCount);
	} finally {
		process.removeListener('SIGTERM', onSignal);
		process.removeListener('SIGINT', onSignal);
		try {
			db.exec('PRAGMA optimize');
		} catch {
			/* ignore */
		}
		db.close();
	}
}

function findLastIncrementalSnapId(dsSnaps) {
	let lastId = null;
	const willBeIndexed = new Set();
	let prevSnap = null;

	for (const snap of dsSnaps) {
		const prevIsIndexed = prevSnap && (prevSnap.indexed_at || willBeIndexed.has(prevSnap.id));
		if (!snap.indexed_at && prevIsIndexed) {
			lastId = snap.id;
		}
		if (!snap.indexed_at) {
			willBeIndexed.add(snap.id);
		}
		prevSnap = snap;
	}
	return lastId;
}

// ─── Full crawl ─────────────────────────────────────────────────────────────

async function doCrawl(db, stmt, perf, snapId, datasetId, snapPath, fullName) {
	console.log(`  🕷  Full crawl ${fullName}...`);
	let count = 0;
	const t0 = Date.now();

	await walkSnapshot(snapPath, (batch) => {
		if (batch === null) {
			return;
		}
		const t = Date.now();
		transaction(db, () => {
			perf.sqlTxns++;
			for (const e of batch) {
				const fileRow = stmt.upsertFile.get(datasetId, e.path, e.inode, e.type, snapId, snapId);
				perf.sqlUpserts++;
				if (!fileRow) {
					continue;
				}
				stmt.insertVersion.run(fileRow.id, snapId, e.size, e.mtime, e.ctime, e.nlink, e.mode);
				perf.sqlInserts++;
			}
		});
		perf.sqlMs += Date.now() - t;
		count += batch.length;
		logBatchProgress('entries', batch.length, count, t0);
	});

	if (count && process.stdout.isTTY) {
		endProgressLine();
	}
	console.log(`    Done: ${count.toLocaleString()} entries in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);
	return count;
}

// ─── Batch constants ────────────────────────────────────────────────────────

const INCR_BATCH_SIZE = 4096;
const STAT_CONCURRENCY = 64;

function sizeFromStat(st) {
	return st.isDirectory() ? 0 : st.size;
}

let _progressAnimTick = 0;

function indeterminateBar(width, tick) {
	const blockLen = Math.max(3, Math.floor(width / 4));
	const range = Math.max(1, width - blockLen + 1);
	const start = tick % range;
	let s = '';
	for (let i = 0; i < width; i++) {
		s += i >= start && i < start + blockLen ? '█' : '░';
	}
	return s;
}

function logBatchProgress(unit, batchLen, total, t0) {
	const elapsedSec = (Date.now() - t0) / 1000;
	const rate = elapsedSec > 0 ? (total / elapsedSec).toFixed(0) : '0';
	_progressAnimTick++;
	if (process.stdout.isTTY) {
		const bar = indeterminateBar(22, _progressAnimTick);
		process.stdout.write(`\r    [${bar}] ${total.toLocaleString()} ${unit}  ${rate}/s\x1b[K`);
	} else {
		console.log(`    +${batchLen.toLocaleString()} ${unit} → ${total.toLocaleString()} total (${rate}/s)`);
	}
}

function endProgressLine() {
	if (process.stdout.isTTY) {
		process.stdout.write('\n');
	}
}

// ─── Incremental (standalone, no changes table) ────────────────────────────

async function doIncremental(db, stmt, perf, prevSnap, snap, datasetId, mountpoint, snapPath) {
	console.log(`  ⚡ Incremental ${snap.name} (from ${prevSnap.name})...`);
	const t0 = Date.now();

	let changeCount = 0;
	let batch = [];

	for await (const c of diffSnapshots(prevSnap.full_name, snap.full_name)) {
		batch.push(c);
		if (batch.length >= INCR_BATCH_SIZE) {
			const n = batch.length;
			await flushIncrementalBatch(db, stmt, perf, batch, snap, datasetId, mountpoint, snapPath);
			changeCount += n;
			batch = [];
			logBatchProgress('changes', n, changeCount, t0);
		}
	}
	if (batch.length) {
		const n = batch.length;
		await flushIncrementalBatch(db, stmt, perf, batch, snap, datasetId, mountpoint, snapPath);
		changeCount += n;
		logBatchProgress('changes', n, changeCount, t0);
	}

	if (changeCount && process.stdout.isTTY) {
		endProgressLine();
	}
	console.log(`    Done: ${changeCount} changes in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);
}

// ─── Unified incremental + diff (single zfs diff pass) ─────────────────────

async function doIncrementalUnified(db, stmt, perf, prevSnap, snap, datasetId, mountpoint, snapPath) {
	console.log(`  ⚡ Incremental+diff ${snap.name} (from ${prevSnap.name})...`);
	const t0 = Date.now();

	let changeCount = 0;
	let batch = [];

	for await (const c of diffSnapshots(prevSnap.full_name, snap.full_name)) {
		batch.push(c);
		if (batch.length >= INCR_BATCH_SIZE) {
			const n = batch.length;
			await flushUnifiedBatch(db, stmt, perf, batch, snap, datasetId, mountpoint, snapPath);
			changeCount += n;
			batch = [];
			logBatchProgress('changes', n, changeCount, t0);
		}
	}
	if (batch.length) {
		const n = batch.length;
		await flushUnifiedBatch(db, stmt, perf, batch, snap, datasetId, mountpoint, snapPath);
		changeCount += n;
		logBatchProgress('changes', n, changeCount, t0);
	}

	if (changeCount && process.stdout.isTTY) {
		endProgressLine();
	}
	console.log(`    Done: ${changeCount} changes in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function resolveRelPath(path, mountpoint) {
	return mountpoint && path.startsWith(mountpoint) ? path.slice(mountpoint.length) || '/' : path;
}

/**
 * Apply a ZFS rename to the files table without creating a "deleted" tombstone.
 * Previously we marked the old path deleted and inserted a new row, which inflated
 * deleted-file counts and split version history across two file_ids.
 *
 * @returns {{ fileId: number | null, oldSize: number | null }}
 */
function applyFileRename(db, stmt, perf, datasetId, relOldPath, relNewPath, st, snapId) {
	const type = typeFromStat(st);
	const sz = sizeFromStat(st);
	const mtime = Math.floor(st.mtimeMs / 1000);
	const ctime = Math.floor(st.ctimeMs / 1000);
	const mode = modeStr(st);

	const oldFile = stmt.getFileByPath.get(datasetId, relOldPath);
	perf.sqlSelects++;
	if (!oldFile) {
		const fileRow = stmt.upsertFile.get(datasetId, relNewPath, st.ino, type, snapId, snapId);
		perf.sqlUpserts++;
		if (fileRow) {
			stmt.insertVersion.run(fileRow.id, snapId, sz, mtime, ctime, st.nlink, mode);
			perf.sqlInserts++;
		}
		return { fileId: fileRow?.id ?? null, oldSize: null };
	}

	const oldSizeRow = stmt.getLatestSize.get(oldFile.id);
	perf.sqlSelects++;
	const oldSize = oldSizeRow?.size ?? null;

	const victim = stmt.getFileByPath.get(datasetId, relNewPath);
	perf.sqlSelects++;
	if (victim && victim.id !== oldFile.id) {
		stmt.deleteChangesByFileId.run(victim.id);
		stmt.deleteVersionsByFileId.run(victim.id);
		stmt.deleteFileById.run(victim.id);
	}

	stmt.updateFileRename.run(relNewPath, st.ino, type, snapId, oldFile.id, datasetId);
	perf.sqlUpdates++;
	stmt.insertVersion.run(oldFile.id, snapId, sz, mtime, ctime, st.nlink, mode);
	perf.sqlInserts++;
	return { fileId: oldFile.id, oldSize };
}

function typeFromStat(st) {
	return st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : 'other';
}

function modeStr(st) {
	return (st.mode & 0o7777).toString(8).padStart(4, '0');
}

async function statBatch(batch, mountpoint, snapPath) {
	const entries = [];
	for (let i = 0; i < batch.length; i++) {
		const c = batch[i];
		if (c.changeType === 'removed') {
			continue;
		}
		let targetPath;
		if (c.changeType === 'renamed') {
			const relNew = resolveRelPath(c.newPath, mountpoint);
			targetPath = snapPath + relNew;
		} else {
			const rel = resolveRelPath(c.path, mountpoint);
			targetPath = snapPath + rel;
		}
		entries.push({ idx: i, fullPath: targetPath });
	}

	const stats = await batchStat(entries, STAT_CONCURRENCY);
	const map = new Map();
	for (let j = 0; j < entries.length; j++) {
		map.set(entries[j].idx, stats[j]);
	}
	return map;
}

// ─── Batch flush: incremental only ─────────────────────────────────────────

async function flushIncrementalBatch(db, stmt, perf, batch, snap, datasetId, mountpoint, snapPath) {
	const t0 = Date.now();
	const statMap = await statBatch(batch, mountpoint, snapPath);
	perf.statMs += Date.now() - t0;

	const t = Date.now();
	transaction(db, () => {
		perf.sqlTxns++;
		for (let i = 0; i < batch.length; i++) {
			const c = batch[i];
			const relPath = resolveRelPath(c.path, mountpoint);

			if (c.changeType === 'added') {
				const st = statMap.get(i);
				if (st) {
					const type = typeFromStat(st);
					const fileRow = stmt.upsertFile.get(datasetId, relPath, st.ino, type, snap.id, snap.id);
					perf.sqlUpserts++;
					if (fileRow) {
						stmt.insertVersion.run(fileRow.id, snap.id, sizeFromStat(st), Math.floor(st.mtimeMs / 1000), Math.floor(st.ctimeMs / 1000), st.nlink, modeStr(st));
						perf.sqlInserts++;
					}
				}
			} else if (c.changeType === 'removed') {
				const fileRow = stmt.getFileByPath.get(datasetId, relPath);
				perf.sqlSelects++;
				if (fileRow) { stmt.markDeleted.run(snap.id, fileRow.id); perf.sqlUpdates++; }
			} else if (c.changeType === 'modified') {
				const st = statMap.get(i);
				if (st) {
					const fileRow = stmt.getFileByPath.get(datasetId, relPath);
					perf.sqlSelects++;
					if (fileRow) {
						stmt.insertVersion.run(fileRow.id, snap.id, sizeFromStat(st), Math.floor(st.mtimeMs / 1000), Math.floor(st.ctimeMs / 1000), st.nlink, modeStr(st));
						perf.sqlInserts++;
					}
				}
			} else if (c.changeType === 'renamed') {
				const relNewPath = resolveRelPath(c.newPath, mountpoint);
				const st = statMap.get(i);
				if (st) {
					applyFileRename(db, stmt, perf, datasetId, relPath, relNewPath, st, snap.id);
				}
			}
		}
	});
	perf.sqlMs += Date.now() - t;
}

// ─── Batch flush: unified incremental + diff ────────────────────────────────

async function flushUnifiedBatch(db, stmt, perf, batch, snap, datasetId, mountpoint, snapPath) {
	const t0 = Date.now();
	const statMap = await statBatch(batch, mountpoint, snapPath);
	perf.statMs += Date.now() - t0;

	const t = Date.now();
	transaction(db, () => {
		perf.sqlTxns++;
		for (let i = 0; i < batch.length; i++) {
			const c = batch[i];
			const relPath = resolveRelPath(c.path, mountpoint);
			const relNewPath = c.changeType === 'renamed' ? resolveRelPath(c.newPath, mountpoint) : null;
			const st = statMap.get(i) ?? null;

			let fileId = null;
			let oldSize = null;
			let newSize = null;

			if (c.changeType === 'added') {
				if (st) {
					const type = typeFromStat(st);
					const fileRow = stmt.upsertFile.get(datasetId, relPath, st.ino, type, snap.id, snap.id);
					perf.sqlUpserts++;
					if (fileRow) {
						fileId = fileRow.id;
						newSize = sizeFromStat(st);
						stmt.insertVersion.run(fileRow.id, snap.id, newSize, Math.floor(st.mtimeMs / 1000), Math.floor(st.ctimeMs / 1000), st.nlink, modeStr(st));
						perf.sqlInserts++;
					}
				}
			} else if (c.changeType === 'removed') {
				const fileRow = stmt.getFileByPath.get(datasetId, relPath);
				perf.sqlSelects++;
				if (fileRow) {
					fileId = fileRow.id;
					oldSize = stmt.getLatestSize.get(fileId)?.size ?? null;
					perf.sqlSelects++;
					stmt.markDeleted.run(snap.id, fileRow.id);
					perf.sqlUpdates++;
				}
			} else if (c.changeType === 'modified') {
				if (st) {
					const fileRow = stmt.getFileByPath.get(datasetId, relPath);
					perf.sqlSelects++;
					if (fileRow) {
						fileId = fileRow.id;
						oldSize = stmt.getLatestSize.get(fileId)?.size ?? null;
						perf.sqlSelects++;
						newSize = sizeFromStat(st);
						stmt.insertVersion.run(fileRow.id, snap.id, newSize, Math.floor(st.mtimeMs / 1000), Math.floor(st.ctimeMs / 1000), st.nlink, modeStr(st));
						perf.sqlInserts++;
					}
				}
			} else if (c.changeType === 'renamed') {
				if (st) {
					newSize = sizeFromStat(st);
					const { fileId: rid, oldSize: rold } = applyFileRename(db, stmt, perf, datasetId, relPath, relNewPath, st, snap.id);
					fileId = rid;
					oldSize = rold;
				}
			}

			if (fileId === null || fileId === undefined) {
				const row = stmt.getFileByPath.get(datasetId, relPath);
				fileId = row?.id ?? null;
				perf.sqlSelects++;
			}

			if (c.changeType === 'added' && fileId && (newSize === null || newSize === undefined)) {
				newSize = stmt.getSizeAtSnapshot.get(fileId, snap.id)?.size ?? null;
				perf.sqlSelects++;
				if (newSize === null || newSize === undefined) {
					newSize = stmt.getSizeByPathAtSnapshot.get(datasetId, relPath, snap.id)?.size ?? null;
					perf.sqlSelects++;
				}
			} else if (c.changeType === 'removed' && fileId && (oldSize === null || oldSize === undefined)) {
				oldSize = stmt.getLatestSize.get(fileId)?.size ?? null;
				perf.sqlSelects++;
			} else if ((c.changeType === 'modified' || c.changeType === 'renamed') && fileId) {
				if (oldSize === null || oldSize === undefined) {
					oldSize = stmt.getLatestSize.get(fileId)?.size ?? null;
					perf.sqlSelects++;
				}
				if (c.changeType === 'modified' && (newSize === null || newSize === undefined)) {
					newSize = stmt.getSizeAtSnapshot.get(fileId, snap.id)?.size ?? null;
					perf.sqlSelects++;
				}
				if (c.changeType === 'renamed' && (newSize === null || newSize === undefined) && relNewPath !== null && relNewPath !== undefined) {
					newSize = stmt.getSizeByPathAtSnapshot.get(datasetId, relNewPath, snap.id)?.size ?? null;
					perf.sqlSelects++;
				}
			}

			const delta = ((newSize !== null && newSize !== undefined) || (oldSize !== null && oldSize !== undefined)) ? (newSize ?? 0) - (oldSize ?? 0) : null;
			stmt.insertChange.run(snap.id, fileId, c.changeType, relPath, relNewPath, oldSize, newSize, delta);
			perf.sqlInserts++;
			perf.diffChanges++;
		}
	});
	perf.sqlMs += Date.now() - t;
}

// ─── Diff for changes table (standalone, when both snaps already indexed) ──

async function doDiff(db, stmt, perf, prevSnap, snap, datasetId, mountpoint) {
	const changes = [];
	let changeCount = 0;
	const t0 = Date.now();
	for await (const change of diffSnapshots(prevSnap.full_name, snap.full_name)) {
		changes.push(change);
		if (changes.length >= INCR_BATCH_SIZE) {
			const chunk = changes.splice(0, INCR_BATCH_SIZE);
			flushChanges(db, stmt, perf, chunk, snap, datasetId, mountpoint);
			changeCount += chunk.length;
			logBatchProgress('changes', chunk.length, changeCount, t0);
		}
	}
	if (changes.length) {
		const n = changes.length;
		flushChanges(db, stmt, perf, changes, snap, datasetId, mountpoint);
		changeCount += n;
		logBatchProgress('changes', n, changeCount, t0);
	}
	if (changeCount && process.stdout.isTTY) {
		endProgressLine();
	}
}

function flushChanges(db, stmt, perf, changes, snap, datasetId, mountpoint) {
	const t = Date.now();
	transaction(db, () => {
		perf.sqlTxns++;
		for (const c of changes) {
			const relPath = resolveRelPath(c.path, mountpoint);
			const relNewPath = c.newPath ? resolveRelPath(c.newPath, mountpoint) : null;

			const fileRow = stmt.getFileByPath.get(datasetId, relPath);
			let fileId = fileRow?.id ?? null;
			perf.sqlSelects++;

			let oldSize = null, newSize = null;
			if (c.changeType === 'removed') {
				if (fileId) { oldSize = stmt.getLatestSize.get(fileId)?.size ?? null; perf.sqlSelects++; }
			} else if (c.changeType === 'added') {
				if (fileId) { newSize = stmt.getSizeAtSnapshot.get(fileId, snap.id)?.size ?? null; perf.sqlSelects++; }
				if (newSize === null || newSize === undefined) { newSize = stmt.getSizeByPathAtSnapshot.get(datasetId, relPath, snap.id)?.size ?? null; perf.sqlSelects++; }
			} else {
				if (fileId) {
					oldSize = stmt.getLatestSize.get(fileId)?.size ?? null;
					newSize = stmt.getSizeAtSnapshot.get(fileId, snap.id)?.size ?? null;
					perf.sqlSelects += 2;
				}
			}

			if (c.changeType === 'removed' && fileId) { stmt.markDeleted.run(snap.id, fileId); perf.sqlUpdates++; }

			const delta = ((newSize !== null && newSize !== undefined) || (oldSize !== null && oldSize !== undefined)) ? (newSize ?? 0) - (oldSize ?? 0) : null;
			stmt.insertChange.run(snap.id, fileId, c.changeType, relPath, c.changeType === 'renamed' ? relNewPath : null, oldSize, newSize, delta);
			perf.sqlInserts++;
			perf.diffChanges++;
		}
	});
	perf.sqlMs += Date.now() - t;
}

// ─── Stats ──────────────────────────────────────────────────────────────────

function printStats(db, perf, sessionWallT0 = null, restartCount = 0) {
	const totalMs =
		(sessionWallT0 !== null && sessionWallT0 !== undefined) ? Date.now() - sessionWallT0 : Date.now() - perf.t0;
	const stats = db.prepare(`SELECT (SELECT COUNT(*) FROM datasets) AS datasets, (SELECT COUNT(*) FROM snapshots) AS snapshots, (SELECT COUNT(*) FROM files) AS files, (SELECT COUNT(*) FROM file_versions) AS versions, (SELECT COUNT(*) FROM changes) AS changes, (SELECT COUNT(*) FROM files WHERE deleted_at_snap_id IS NOT NULL) AS deleted`).get();

	const pgSz = Object.values(db.prepare('SELECT * FROM pragma_page_size()').get())[0];
	const pgCount = Object.values(db.prepare('SELECT * FROM pragma_page_count()').get())[0];
	const pgFree = Object.values(db.prepare('SELECT * FROM pragma_freelist_count()').get())[0];
	const jMode = Object.values(db.prepare('SELECT * FROM pragma_journal_mode()').get())[0];
	const cSz = Object.values(db.prepare('SELECT * FROM pragma_cache_size()').get())[0];

	console.log('\n📊 Index stats:');
	console.log(`Datasets: ${stats.datasets}`);
	console.log(`Snapshots: ${stats.snapshots}`);
	console.log(`Unique files: ${stats.files.toLocaleString()}`);
	console.log(`File versions: ${stats.versions.toLocaleString()}`);
	console.log(`Change events: ${stats.changes.toLocaleString()}`);
	console.log(`Deleted files: ${stats.deleted.toLocaleString()}`);

	console.log('\n💾 SQLite:');
	console.log(`DB size: ${formatSize(pgSz * pgCount)}`);
	console.log(`Used: ${formatSize(pgSz * (pgCount - pgFree))} (${pgCount - pgFree} pages)`);
	console.log(`Free: ${formatSize(pgSz * pgFree)} (${pgFree} pages)`);
	console.log(`Page size: ${formatSize(pgSz)}`);
	console.log(`Journal mode: ${jMode}`);
	console.log(`Cache size: ${Math.abs(cSz)}${cSz < 0 ? 'KiB' : ' pages'}`);

	console.log('\n⏱  Performance:');
	console.log(`Total runtime: ${formatDuration(totalMs)}`);
	if (restartCount > 0) {
		console.log(`Restarts: ${restartCount}`);
		console.log('Note: Crawl/diff/SQL counters below are for the last completed pass only.');
	}
	console.log(`Crawl time: ${formatDuration(perf.crawlMs)}`);
	console.log(`Diff time: ${formatDuration(perf.diffMs)}`);
	console.log(`Stat time: ${formatDuration(perf.statMs)}`);
	console.log(`Full crawls: ${perf.snapsCrawled}`);
	console.log(`Incremental: ${perf.snapsIncremental}`);
	console.log(`Skipped: ${perf.snapsSkipped}`);
	console.log(`Diffs processed: ${perf.diffsDone}`);
	console.log(`Diff changes: ${perf.diffChanges.toLocaleString()}`);
	console.log(`Files crawled: ${perf.filesCrawled.toLocaleString()}`);
	if (perf.crawlMs > 0 && perf.filesCrawled > 0) {
		console.log(`Crawl rate: ${(perf.filesCrawled / (perf.crawlMs / 1000)).toFixed(0)} files/s`);
	}

	const totalOps = perf.sqlInserts + perf.sqlUpserts + perf.sqlSelects + perf.sqlUpdates;
	console.log('\n🗄  SQL:');
	console.log(`Total queries: ${totalOps.toLocaleString()}`);
	console.log(`Inserts: ${perf.sqlInserts.toLocaleString()}`);
	console.log(`Upserts: ${perf.sqlUpserts.toLocaleString()}`);
	console.log(`Selects: ${perf.sqlSelects.toLocaleString()}`);
	console.log(`Updates: ${perf.sqlUpdates.toLocaleString()}`);
	console.log(`Transactions: ${perf.sqlTxns.toLocaleString()}`);
	console.log(`SQL time: ${formatDuration(perf.sqlMs)}`);
	if (totalMs > 0) {
		console.log(`SQL % of total: ${(perf.sqlMs / totalMs * 100).toFixed(1)}%`);
	}
	if (perf.sqlMs > 0 && totalOps > 0) {
		console.log(`SQL ops/s: ${(totalOps / (perf.sqlMs / 1000)).toFixed(0)}`);
		console.log(`Avg per op: ${(perf.sqlMs / totalOps * 1000).toFixed(1)}μs`);
	}
}

module.exports = { run };
