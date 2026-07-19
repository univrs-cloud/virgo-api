import DataService from '../src/database/data_service.js';
import * as database from './db.js';
import * as zfs from './zfs.js';
import * as walker from './walker.js';
import * as utils from './utils.js';
import { execaSync } from 'execa';
import { BATCH_SIZE } from './constants.js';
import { makeSnapshotStatError, isSnapshotStatFailure, primeMountReadable } from './snapshot_util.js';
import { flushIncrementalBatch, flushUnifiedBatch, flushChanges, reportSnapshotAnomalies } from './flush.js';
import { logBatchProgress, endProgressLine } from './progress.js';
import { printStats } from './stats.js';

const INCR_BATCH_SIZE = BATCH_SIZE;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function umountSnapshot(snapPath) {
	try {
		execaSync('umount', [snapPath]);
	} catch {
		/* ignore */
	}
}

function restartIndexerFromBeginning(message) {
	const e = new Error(message);
	e.code = 'INDEXER_RESTART_FROM_BEGINNING';
	throw e;
}

/**
 * Single error-handling path for all snapshot processing.
 *
 *   - Known recoverable failures (zfs diff died, snapshot mount unreadable):
 *     log + cleanup partial rows + throw INDEXER_RESTART_FROM_BEGINNING so the
 *     outer run loop retries the whole pass (lets retention/automount races
 *     settle on their own).
 *   - Anything else (FK violation, unexpected JS error, etc.): log + cleanup
 *     partial rows + throw SNAPSHOT_SKIPPED so the snapshot loop catches it
 *     and moves on to the next snapshot. The snapshot stays `indexed_at = NULL`
 *     so the next run will re-attempt it cleanly. We never lose the entire run
 *     to a single bad snapshot.
 *
 * @returns {never}
 */
function handleSnapshotError(db, stmt, perf, e, snap, prevSnap, datasetId, mode) {
	const recoverable = zfs.isZfsDiffFailure(e) || isSnapshotStatFailure(e);
	const transition = prevSnap ? `${prevSnap.name} → ${snap.name}` : snap.name;
	if (zfs.isZfsDiffFailure(e)) {
		console.warn(`  ⚠  zfs diff failed (${transition}): ${e.message}`);
	} else if (isSnapshotStatFailure(e)) {
		console.warn(`  ⚠  ${e.message}`);
	} else {
		console.warn(`  ⚠  Unexpected error processing ${transition}: ${e.message}`);
		if (e.stack) {
			console.warn(e.stack);
		}
	}
	if (perf && Array.isArray(perf.failedSnapshots)) {
		perf.failedSnapshots.push({
			name: snap.full_name ?? snap.name,
			reason: e.code ?? 'UNEXPECTED',
			message: e.message,
		});
	}
	console.log('  🧹 Cleaning up partial index/diff rows for this snapshot…');
	try {
		cleanupPartialDiffWork(db, stmt, snap.id, datasetId, mode);
	} catch (cleanupErr) {
		console.warn(`  ⚠  Cleanup also failed: ${cleanupErr.message}`);
	}
	if (recoverable) {
		restartIndexerFromBeginning(
			`${e.code} on ${snap.name}; restarting from beginning so retention/deleted snapshots are re-discovered.`
		);
	}
	const skip = new Error(`Skipping snapshot ${snap.full_name ?? snap.name}: ${e.message}`);
	skip.code = 'SNAPSHOT_SKIPPED';
	skip.cause = e;
	throw skip;
}

function cleanupPartialDiffWork(db, stmt, snapId, datasetId, mode) {
	database.transaction(db, () => {
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
		database.transaction(db, () => {
			stmt.deleteChangesForDataset.run(id);
			stmt.deleteFileVersionsForDataset.run(id);
			stmt.deleteFilesForDataset.run(id);
			stmt.deleteSnapshotsForDataset.run(id);
			stmt.deleteDatasetById.run(id);
		});
	}
}

function persistLastRunMeta(db, stmt, perf, restartCount) {
	database.transaction(db, () => {
		stmt.setMeta.run('last_run_at', new Date().toISOString());
		stmt.setMeta.run('last_run_orphan_changes', String(perf.orphanedChanges));
		stmt.setMeta.run('last_run_stat_failures', String(perf.statFailures));
		stmt.setMeta.run('last_run_restart_count', String(restartCount));
		stmt.setMeta.run('last_run_failed_snapshots', JSON.stringify(perf.failedSnapshots));
		stmt.setMeta.run('last_run_orphan_samples', JSON.stringify(perf.orphanSamplesAll ?? []));
		stmt.setMeta.run('last_run_backfilled_files', String(perf.backfilledFiles ?? 0));
	});
}

function finishIndexerRun(db, stmt, perf, sessionWallT0, restartCount, message) {
	persistLastRunMeta(db, stmt, perf, restartCount);
	console.log(message);
	printStats(db, perf, sessionWallT0, restartCount);
}

async function processSnapshotWithTiming(db, stmt, perf, snap, prevSnap, datasetId, mode, work) {
	const t0 = Date.now();
	try {
		const result = await work();
		return { ms: Date.now() - t0, result };
	} catch (e) {
		handleSnapshotError(db, stmt, perf, e, snap, prevSnap, datasetId, mode);
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
	const staleTemps = zfs.cleanupStaleTempFiles();
	if (staleTemps > 0) {
		console.log(`🧹 Cleaned up ${staleTemps} stale zfs-diff temp file(s) from previous run(s).`);
	}

	const configuration = await DataService.getConfiguration();
	const includeDatasets = normalizeIndexerDatasets(configuration);

	if (!includeDatasets.length) {
		console.log(
			'Indexer: Configuration key `indexer` is missing, empty, or not a JSON array (virgo.db); clearing the index database.'
		);
		const lockPath = utils.acquireLock(database.INDEX_DB_PATH);
		try {
			const db = database.open();
			try {
				const stmt = prepareDatasetPruneStatements(db);
				pruneStaleIndexedDatasets(db, stmt, [], new Set());
				database.disableBulkMode(db);
				const lastRunAt = new Date().toISOString();
				database.transaction(db, () => {
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
			utils.releaseLock(lockPath);
		}
		return;
	}

	const lockPath = utils.acquireLock(database.INDEX_DB_PATH);
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
		utils.releaseLock(lockPath);
	}
}

async function runIndexerPass(includeDatasets, sessionWallT0 = null, restartCount = 0, lockPath = null) {
	const pool = includeDatasets[0].split('/')[0];

	const db = database.open();

	const perf = {
		t0: Date.now(), snapsCrawled: 0, snapsIncremental: 0, snapsSkipped: 0,
		diffsDone: 0, filesCrawled: 0, crawlMs: 0, diffMs: 0,
		sqlInserts: 0, sqlUpserts: 0, sqlSelects: 0, sqlUpdates: 0, sqlTxns: 0, sqlMs: 0,
		diffChanges: 0, statMs: 0,
		statFailures: 0, orphanedChanges: 0,
		// Count of `files` rows created on the fly because `zfs diff` reported a
		// change for a path we hadn't indexed yet. A small steady number is fine
		// (logs/caches appearing post-baseline); a sudden spike hints at gaps in
		// the walker output.
		backfilledFiles: 0,
		// Per-snapshot samples reset by reportSnapshotAnomalies; per-run samples
		// accumulate across the entire pass and get persisted to meta so the
		// dashboard + CLI summary can show actual offending paths after a run.
		orphanSamples: [],
		orphanSamplesAll: [],
		failedSnapshots: [],
	};

	// ── Prepared statements ──
	const stmt = {
		upsertDataset: db.prepare(`INSERT INTO datasets(name, pool, mountpoint, created_at) VALUES(?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET mountpoint=excluded.mountpoint RETURNING id`),
		upsertSnapshot: db.prepare(`INSERT INTO snapshots(dataset_id, name, full_name, created_at, used_bytes, referenced_bytes) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(full_name) DO UPDATE SET used_bytes=excluded.used_bytes, referenced_bytes=excluded.referenced_bytes RETURNING id`),
		getSnapshotByFullName: db.prepare(`SELECT id FROM snapshots WHERE full_name=?`),
		getSnapshotsForDataset: db.prepare(`SELECT id, name, full_name, created_at, indexed_at, diff_done FROM snapshots WHERE dataset_id=? ORDER BY created_at ASC`),
		markIndexed: db.prepare(`UPDATE snapshots SET indexed_at=? WHERE id=?`),
		markDiffDone: db.prepare(`UPDATE snapshots SET diff_done=1 WHERE id=?`),
		upsertFile: db.prepare(`INSERT INTO files(dataset_id, path, inode, type, first_seen_snap_id, last_seen_snap_id) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(dataset_id, path) DO UPDATE SET inode=excluded.inode, type=excluded.type, last_seen_snap_id=excluded.last_seen_snap_id, deleted_at_snap_id=NULL RETURNING id`),
		insertVersion: db.prepare(`INSERT OR IGNORE INTO file_versions(file_id, snapshot_id, size, mtime, ctime, nlink, mode) VALUES(?, ?, ?, ?, ?, ?, ?)`),
		getFileByPath: db.prepare(`SELECT id FROM files WHERE dataset_id = ? AND path = ?`),
		// Bulk fetch (id, path, latest size) for every path in a batch via
		// json_each so we don't do 4096 individual selects per flush. Used by
		// the incremental and unified incremental+diff hot paths.
		bulkLookupFiles: db.prepare(`
			SELECT f.path, f.id,
				(SELECT size FROM file_versions WHERE file_id = f.id ORDER BY snapshot_id DESC LIMIT 1) AS latest_size
			FROM json_each(?1) j
			INNER JOIN files f ON f.path = j.value AND f.dataset_id = ?2
		`),
		// Same as bulkLookupFiles but additionally returns the size at a
		// specific snapshot. Used by the standalone diff path where both
		// snapshots are already indexed.
		bulkLookupFilesWithSnap: db.prepare(`
			SELECT f.path, f.id,
				(SELECT size FROM file_versions WHERE file_id = f.id ORDER BY snapshot_id DESC LIMIT 1) AS latest_size,
				(SELECT size FROM file_versions WHERE file_id = f.id AND snapshot_id = ?3 LIMIT 1) AS size_at_snap
			FROM json_each(?1) j
			INNER JOIN files f ON f.path = j.value AND f.dataset_id = ?2
		`),
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
				database.disableBulkMode(db);
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
			utils.releaseLock(lockPath);
		}
		process.exit(sig === 'SIGTERM' ? 143 : 130);
	};
	process.on('SIGTERM', onSignal);
	process.on('SIGINT', onSignal);

	try {
		console.log('🔍 Discovering ZFS datasets and snapshots...');
		console.log(`   Pool: ${pool}`);
		console.log(`   Include: ${includeDatasets.join(', ')}`);

		const { datasets, snapshots } = zfs.discoverAll({ pool });
		// Pool-wide discovery; keep only configured roots and their descendants.
		const filteredDatasets = datasets.filter(d => datasetInIncludeScope(d.name, includeDatasets));
		const liveDatasetNames = new Set(filteredDatasets.map(d => d.name));
		pruneStaleIndexedDatasets(db, stmt, includeDatasets, liveDatasetNames);

		if (!filteredDatasets.length) {
			console.log('No datasets matched the filter.');
			finishIndexerRun(db, stmt, perf, sessionWallT0, restartCount, '\n✅ Indexing complete (no datasets to process).');
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
					database.transaction(db, () => {
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
		database.transaction(db, () => {
			for (const d of filteredDatasets) {
				const dsId = datasetIds[d.name];
				stmt.repairLastSeenNull.run(dsId);
				stmt.repairFirstSeenNull.run(dsId);
			}
			stmt.deleteChangesForOrphanedFiles.run();
			stmt.deleteOrphanedFiles.run();
		});

		// Precompute each dataset's snapshot list so we can decide whether this
		// pass will do any full crawl before touching FTS trigger state.
		const datasetWork = filteredDatasets.map(d => ({
			d,
			dsId: datasetIds[d.name],
			dsSnaps: stmt.getSnapshotsForDataset.all(datasetIds[d.name]),
		}));

		// Bulk mode drops the FTS triggers and rebuilds the whole index in one
		// shot at the end — a big win for full crawls, but pure overhead for a
		// steady-state pass that only ingests a small incremental diff. Only pay
		// it when a full crawl is actually going to run (or when the triggers are
		// missing, e.g. a previous run was SIGKILLed before restoring them).
		const needBulkMode = !ftsTriggersPresent(db)
			|| datasetWork.some(({ d, dsSnaps }) => willDoFullCrawl(dsSnaps, d.mountpoint));
		if (needBulkMode) {
			database.enableBulkMode(db);
			inBulkMode = true;
		}

		database.transaction(db, () => {
			stmt.setMeta.run('last_activity_at', new Date().toISOString());
		});

		for (const { d, dsId, dsSnaps } of datasetWork) {
			console.log(`\n📦 Dataset: ${d.name} (${dsSnaps.length} snapshots)`);

			const lastIncrSnapId = findLastIncrementalSnapId(dsSnaps);

			let prevSnap = null;
			let snapIdx = 0;
			for (const snap of dsSnaps) {
				try {
					const snapPath = zfs.snapshotMountPath(d.mountpoint, snap.name);

					const needIndex = !snap.indexed_at;
					const needDiff = prevSnap && !snap.diff_done;
					const canIncremental = needIndex && prevSnap && prevSnap.indexed_at;

					if (needIndex) {
						if (!snapPath) {
							prevSnap = snap;
							continue;
						}

						if (canIncremental && needDiff) {
							const { ms } = await processSnapshotWithTiming(db, stmt, perf, snap, prevSnap, dsId, 'incremental', () =>
								doIncrementalUnified(db, stmt, perf, prevSnap, snap, dsId, d.mountpoint, snapPath)
							);
							perf.crawlMs += ms;
							perf.snapsIncremental++;
							perf.diffsDone++;
							stmt.markDiffDone.run(snap.id);
						} else if (canIncremental) {
							const { ms } = await processSnapshotWithTiming(db, stmt, perf, snap, prevSnap, dsId, 'incremental', () =>
								doIncremental(db, stmt, perf, prevSnap, snap, dsId, d.mountpoint, snapPath)
							);
							perf.crawlMs += ms;
							perf.snapsIncremental++;
						} else {
							const { ms, result: count } = await processSnapshotWithTiming(db, stmt, perf, snap, prevSnap, dsId, 'incremental', () =>
								doCrawl(db, stmt, perf, snap.id, dsId, snapPath, snap.full_name)
							);
							perf.filesCrawled += count;
							perf.crawlMs += ms;
							perf.snapsCrawled++;
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
							const { ms } = await processSnapshotWithTiming(db, stmt, perf, snap, prevSnap, dsId, 'changes_only', () =>
								doDiff(db, stmt, perf, prevSnap, snap, dsId, d.mountpoint)
							);
							perf.diffMs += ms;
							perf.diffsDone++;
							stmt.markDiffDone.run(snap.id);
						}
					}

					prevSnap = snap;
					snapIdx++;

					if (snapIdx % 10 === 0) {
						database.checkpoint(db);
						database.transaction(db, () => {
							stmt.setMeta.run('last_activity_at', new Date().toISOString());
						});
					}
				} catch (e) {
					if (e.code !== 'SNAPSHOT_SKIPPED') {
						// INDEXER_RESTART_FROM_BEGINNING and genuine bugs propagate out.
						throw e;
					}
					// Leave `prevSnap` pointing at the last *successful* snapshot so
					// the next iteration's incremental/diff has clean data to work
					// against. Snapshot stays unindexed → retried on next run.
				}
			}

			if (lastIncrSnapId !== null && lastIncrSnapId !== undefined) {
				const t = Date.now();
				stmt.bumpLastSeen.run(lastIncrSnapId, dsId);
				perf.sqlUpdates++;
				perf.sqlMs += Date.now() - t;
			}
		}

		if (inBulkMode) {
			database.disableBulkMode(db);
			inBulkMode = false;
		}

		finishIndexerRun(db, stmt, perf, sessionWallT0, restartCount, '\n✅ Indexing complete.');
	} finally {
		process.removeListener('SIGTERM', onSignal);
		process.removeListener('SIGINT', onSignal);
		// Make sure FTS triggers etc. are restored even if the run crashed
		// before the explicit disableBulkMode above.
		if (inBulkMode) {
			try {
				database.disableBulkMode(db);
				inBulkMode = false;
			} catch (e) {
				console.warn(`  ⚠  disableBulkMode failed during cleanup: ${e.message}`);
			}
		}
		try {
			db.exec('PRAGMA optimize');
		} catch {
			/* ignore */
		}
		db.close();
	}
}

/**
 * Are the FTS maintenance triggers currently installed? They're dropped during
 * bulk mode and recreated by disableBulkMode; if a previous run was killed
 * before restoring them, the index would silently stop tracking new paths — so
 * a missing trigger forces a full bulk-mode rebuild this pass.
 */
function ftsTriggersPresent(db) {
	const row = db.prepare(`
		SELECT COUNT(*) AS n FROM sqlite_master
		WHERE type = 'trigger' AND name IN ('fts_paths_ai', 'fts_paths_ad', 'fts_paths_au')
	`).get();
	return row.n === 3;
}

/**
 * Mirror the per-snapshot branch selection in the dataset loop to decide, ahead
 * of time, whether this pass will hit the full-crawl path for a dataset. A full
 * crawl happens for an unindexed snapshot whose predecessor isn't indexed (the
 * first snapshot of a brand-new dataset, or a gap). Datasets with no mountpoint
 * never get a snapshot path, so nothing is crawled. Being conservative here only
 * affects the bulk-mode perf decision, never correctness.
 */
function willDoFullCrawl(dsSnaps, mountpoint) {
	if (!mountpoint) {
		return false;
	}
	let prevIndexed = false;
	for (const snap of dsSnaps) {
		if (!snap.indexed_at && !prevIndexed) {
			return true;
		}
		// Whether it was already indexed or gets indexed this pass, the next
		// snapshot sees an indexed predecessor.
		prevIndexed = true;
	}
	return false;
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

	const result = await walker.walkSnapshot(snapPath, (batch) => {
		if (batch === null) {
			return;
		}
		const t = Date.now();
		database.transaction(db, () => {
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

	perf.statFailures += result.statFailures;
	perf.crawlSkippedDirs = (perf.crawlSkippedDirs ?? 0) + result.skippedDirs;

	if (count && process.stdout.isTTY) {
		endProgressLine();
	}
	console.log(`    Done: ${count.toLocaleString()} entries in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);
	if (result.statFailures > 0 || result.skippedDirs > 0) {
		console.log(`    ⚠  ${result.statFailures.toLocaleString()} stat failure(s), ${result.skippedDirs.toLocaleString()} dir(s) skipped during crawl.`);
	}
	return count;
}

// ─── Snapshot mount priming ─────────────────────────────────────────────────

/**
 * Prime the snapshot's automount before we start a batch loop, aborting the
 * snapshot via `SNAPSHOT_STAT_FAILED` if it stays unreadable so the snapshot
 * loop can clean up and restart from the beginning.
 */
async function primeSnapshotMount(snap, snapPath) {
	if (!(await primeMountReadable(snapPath))) {
		throw makeSnapshotStatError(snap, snapPath, 1, 1);
	}
}

// ─── Diff streaming ─────────────────────────────────────────────────────────

/**
 * Stream zfs diff output in batches. Shared by incremental, unified, and
 * changes-only diff paths.
 */
async function runDiffStream({
	prevSnap,
	snap,
	mountpoint,
	perf,
	flushBatch,
	logLabel = null,
	primeMount = false,
	snapPath = null,
	reportAnomalies = false,
	logDone = false,
}) {
	if (logLabel) {
		console.log(logLabel);
	}
	if (primeMount) {
		await primeSnapshotMount(snap, snapPath);
	}

	const t0 = Date.now();
	const orphans0 = perf.orphanedChanges;
	const statFails0 = perf.statFailures;
	let changeCount = 0;
	let batch = [];

	for await (const c of zfs.diffSnapshots(prevSnap.full_name, snap.full_name, mountpoint)) {
		batch.push(c);
		if (batch.length >= INCR_BATCH_SIZE) {
			const n = batch.length;
			await flushBatch(batch);
			changeCount += n;
			batch = [];
			logBatchProgress('changes', n, changeCount, t0);
		}
	}
	if (batch.length) {
		const n = batch.length;
		await flushBatch(batch);
		changeCount += n;
		logBatchProgress('changes', n, changeCount, t0);
	}

	if (changeCount && process.stdout.isTTY) {
		endProgressLine();
	}
	if (logDone) {
		console.log(`    Done: ${changeCount} changes in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
	}
	if (reportAnomalies) {
		reportSnapshotAnomalies(perf, orphans0, statFails0);
	}
}

// ─── Incremental (standalone, no changes table) ────────────────────────────

async function doIncremental(db, stmt, perf, prevSnap, snap, datasetId, mountpoint, snapPath) {
	await runDiffStream({
		prevSnap,
		snap,
		mountpoint,
		snapPath,
		perf,
		flushBatch: (batch) => flushIncrementalBatch(db, stmt, perf, batch, snap, datasetId, mountpoint, snapPath),
		logLabel: `  ⚡ Incremental ${snap.name} (from ${prevSnap.name})...`,
		primeMount: true,
		reportAnomalies: true,
		logDone: true,
	});
}

// ─── Unified incremental + diff (single zfs diff pass) ─────────────────────

async function doIncrementalUnified(db, stmt, perf, prevSnap, snap, datasetId, mountpoint, snapPath) {
	await runDiffStream({
		prevSnap,
		snap,
		mountpoint,
		snapPath,
		perf,
		flushBatch: (batch) => flushUnifiedBatch(db, stmt, perf, batch, snap, datasetId, mountpoint, snapPath),
		logLabel: `  ⚡ Incremental+diff ${snap.name} (from ${prevSnap.name})...`,
		primeMount: true,
		reportAnomalies: true,
		logDone: true,
	});
}

// ─── Diff for changes table (standalone, when both snaps already indexed) ──

async function doDiff(db, stmt, perf, prevSnap, snap, datasetId, mountpoint) {
	await runDiffStream({
		prevSnap,
		snap,
		mountpoint,
		perf,
		flushBatch: (batch) => {
			flushChanges(db, stmt, perf, batch, snap, datasetId, mountpoint);
		},
	});
}

export { run };
