import DataService from '../src/database/data_service.js';
import * as database from './db.js';
import * as zfs from './zfs.js';
import * as walker from './walker.js';
import * as utils from './utils.js';
import { execaSync } from 'execa';
import { stat } from 'fs/promises';

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

/**
 * Stat each entry's `fullPath`. Returns an array of stat results (null on
 * failure) and a count of failures, so callers can decide whether to abort
 * the whole snapshot (wholesale stat failure usually means the ZFS snapshot
 * automount didn't take and EVERY path will fail).
 */
async function batchStat(entries, concurrency = 64) {
	const results = new Array(entries.length);
	let failures = 0;
	for (let i = 0; i < entries.length; i += concurrency) {
		const slice = entries.slice(i, i + concurrency);
		const stats = await Promise.all(slice.map(e => safeStatAsync(e.fullPath)));
		for (let j = 0; j < slice.length; j++) {
			const s = stats[j];
			results[i + j] = s;
			if (!s) {
				failures++;
			}
		}
	}
	return { results, failures };
}

function restartIndexerFromBeginning(message) {
	const e = new Error(message);
	e.code = 'INDEXER_RESTART_FROM_BEGINNING';
	throw e;
}

/**
 * A snapshot mount that should be readable isn't. Almost always the ZFS
 * `.zfs/snapshot/<name>` automount didn't take. Treated like a zfs-diff
 * failure by the snapshot loop: cleanup partial work + restart from the
 * beginning so retention/automount races sort themselves out.
 */
function isSnapshotStatFailure(e) {
	return Boolean(e && e.code === 'SNAPSHOT_STAT_FAILED');
}

function makeSnapshotStatError(snap, snapPath, failures, total) {
	const ratio = total ? (failures / total) : 1;
	const msg = total
		? `Snapshot mount unreadable for ${snap.full_name}: ${failures}/${total} stat() calls failed (${(ratio * 100).toFixed(0)}%). Path=${snapPath}.`
		: `Snapshot mount unreadable for ${snap.full_name}. Path=${snapPath}.`;
	const e = new Error(msg);
	e.code = 'SNAPSHOT_STAT_FAILED';
	return e;
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
		const filteredDatasets = datasets.filter(d =>
			includeDatasets.some(p => d.name === p || d.name.startsWith(p + '/'))
		);
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

		database.enableBulkMode(db);
		inBulkMode = true;

		database.transaction(db, () => {
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

		database.disableBulkMode(db);
		inBulkMode = false;

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

// ─── Batch constants ────────────────────────────────────────────────────────

const INCR_BATCH_SIZE = 4096;
const STAT_CONCURRENCY = 64;

// If more than this fraction of stat() calls in a batch return null (and the
// sample is at least STAT_FAILURE_MIN_SAMPLE entries), treat it as a wholesale
// snapshot-mount failure and abort the snapshot. The threshold is high because
// some real changes are legitimately ENOENT on the snapshot mount (file was
// deleted between zfs diff and our stat) — but losing >50% of a non-trivial
// batch is unambiguously a mount problem, not normal churn.
const STAT_FAILURE_ABORT_RATIO = 0.5;
const STAT_FAILURE_MIN_SAMPLE = 32;

function sizeFromStat(st) {
	return st.isDirectory() ? 0 : st.size;
}

function insertVersionFromStat(stmt, perf, fileId, snapId, st) {
	const size = sizeFromStat(st);
	stmt.insertVersion.run(fileId, snapId, size, Math.floor(st.mtimeMs / 1000), Math.floor(st.ctimeMs / 1000), st.nlink, modeStr(st));
	perf.sqlInserts++;
	return size;
}

/**
 * Create (or refresh) a `files` row from a successful stat result. Used when
 * `zfs diff` reports a change for a path we don't have indexed yet — usually a
 * file that didn't exist in the earliest indexed snapshot, or whose `added`
 * event got lost in a previous run's partial failure. Self-healing: once the
 * row is here, subsequent events on the same path land normally.
 *
 * Increments `perf.backfilledFiles` so the run summary can flag how often
 * this happens (a steady non-zero rate hints at a deeper indexing gap).
 *
 * Returns the inserted file row, plus the new size for caller's bookkeeping.
 */
function upsertFileFromStat(stmt, perf, datasetId, relPath, st, snapId) {
	const type = typeFromStat(st);
	const fileRow = stmt.upsertFile.get(datasetId, relPath, st.ino, type, snapId, snapId);
	perf.sqlUpserts++;
	if (!fileRow) {
		return { fileRow: null, newSize: null };
	}
	const newSize = insertVersionFromStat(stmt, perf, fileRow.id, snapId, st);
	perf.backfilledFiles = (perf.backfilledFiles ?? 0) + 1;
	return { fileRow, newSize };
}

function assertBatchStatHealthy(snap, snapPath, statFailures, statTotal) {
	if (statTotal >= STAT_FAILURE_MIN_SAMPLE && statFailures / statTotal >= STAT_FAILURE_ABORT_RATIO) {
		throw makeSnapshotStatError(snap, snapPath, statFailures, statTotal);
	}
}

async function prepareIncrementalFlushContext(batch, snap, snapPath, mountpoint, perf, datasetId, stmt) {
	const t0 = Date.now();
	const { map: statMap, statTotal, statFailures } = await statBatch(batch, mountpoint, snapPath);
	perf.statMs += Date.now() - t0;
	perf.statFailures += statFailures;
	assertBatchStatHealthy(snap, snapPath, statFailures, statTotal);
	const paths = resolveBatchPaths(batch, mountpoint);
	const fileByPath = bulkLoadFileMap(stmt, perf, datasetId, paths.lookup);
	return { statMap, ...paths, fileByPath };
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

/**
 * Touch the snapshot's automount root before we start a batch loop.
 *
 * ZFS auto-mounts snapshots lazily on first access to
 * `<dataset>/.zfs/snapshot/<name>`. Without priming, our first big parallel
 * `stat()` salvo can race the kernel and every call returns ENOENT,
 * silently producing orphan change rows for the whole snapshot.
 *
 * Strategy: one stat, one short sleep, one retry. If it's still unreadable,
 * abort the snapshot via `SNAPSHOT_STAT_FAILED` so the snapshot loop catches
 * it, runs `cleanupPartialDiffWork`, and we restart from the beginning.
 */
async function primeSnapshotMount(snap, snapPath) {
	let st = await safeStatAsync(snapPath);
	if (st) {
		return;
	}
	await new Promise(r => setTimeout(r, 250));
	st = await safeStatAsync(snapPath);
	if (st) {
		return;
	}
	throw makeSnapshotStatError(snap, snapPath, 1, 1);
}

// ─── Incremental (standalone, no changes table) ────────────────────────────

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

// Per-snapshot cap (the inline ⚠ line shows a handful so the user has context
// without flooding the log). Per-run cap is larger because we persist that set
// to meta and surface it in the dashboard / CLI summary.
const ORPHAN_SAMPLE_LIMIT = 5;
const ORPHAN_SAMPLE_RUN_LIMIT = 50;

function sampleOrphan(perf, snap, changeType, relPath, relNewPath, statFailed, source) {
	const entry = {
		snapshot: snap?.full_name ?? snap?.name ?? null,
		type: changeType,
		path: relNewPath ? `${relPath} → ${relNewPath}` : relPath,
		cause: statFailed ? 'stat-failed' : 'no-file-row',
		source,
	};
	if (perf.orphanSamples && perf.orphanSamples.length < ORPHAN_SAMPLE_LIMIT) {
		perf.orphanSamples.push(entry);
	}
	if (perf.orphanSamplesAll && perf.orphanSamplesAll.length < ORPHAN_SAMPLE_RUN_LIMIT) {
		perf.orphanSamplesAll.push(entry);
	}
}

function reportSnapshotAnomalies(perf, orphans0, statFails0) {
	const orphans = perf.orphanedChanges - orphans0;
	const statFails = perf.statFailures - statFails0;
	if (orphans > 0) {
		console.log(`    ⚠  ${orphans.toLocaleString()} change event(s) skipped (no matching file row) — usually a path-normalisation or earlier-snapshot failure.`);
		for (const s of perf.orphanSamples) {
			console.log(`        · [${s.type}/${s.cause}] ${s.path}`);
		}
		if (orphans > perf.orphanSamples.length) {
			console.log(`        · …and ${(orphans - perf.orphanSamples.length).toLocaleString()} more`);
		}
	}
	if (statFails > 0) {
		console.log(`    ⚠  ${statFails.toLocaleString()} stat() failure(s) on snapshot mount — file may have been removed between zfs-diff and stat.`);
	}
	// Reset the per-snapshot orphan sample buffer for the next snapshot.
	perf.orphanSamples = [];
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function resolveRelPath(path, mountpoint) {
	return mountpoint && path.startsWith(mountpoint) ? path.slice(mountpoint.length) || '/' : path;
}

/**
 * Patch the in-batch `fileByPath` map so it reflects DB mutations made by
 * `applyFileRename`. The bulk lookup is taken once at batch start; if we
 * don't sync it after each rename, later changes in the same batch can hit
 * stale entries — e.g. a `victim` deleted by an earlier rename whose path
 * is now referenced again, leading to FK constraint failures on
 * `insertVersion(stale_id, ...)`.
 *
 * Semantics:
 *   - victim deleted  → drop map[relNewPath] (the row it pointed to is gone)
 *   - oldFile moved   → drop map[relOldPath], set map[relNewPath] = oldFile
 *   - no oldFile      → set map[relNewPath] = the newly upserted row
 */
function syncMapForRename(fileByPath, relOldPath, relNewPath, oldFile, victim, resultFileId, newSize) {
	if (victim && (!oldFile || victim.id !== oldFile.id)) {
		fileByPath.delete(relNewPath);
	}
	if (oldFile) {
		fileByPath.delete(relOldPath);
		fileByPath.set(relNewPath, { ...oldFile, latestSize: newSize ?? oldFile.latestSize ?? null });
	} else if (resultFileId) {
		fileByPath.set(relNewPath, { id: resultFileId, latestSize: newSize ?? null });
	}
}

/**
 * Apply a ZFS rename to the files table without creating a "deleted" tombstone.
 * Previously we marked the old path deleted and inserted a new row, which inflated
 * deleted-file counts and split version history across two file_ids.
 *
 * `oldFile` and `victim` should come from the batch's prefetched bulk lookup
 * map (see flushUnifiedBatch / flushIncrementalBatch). Pass undefined if the
 * caller doesn't know yet and we'll fall back to a direct select.
 *
 * @returns {{ fileId: number | null, oldSize: number | null }}
 */
function applyFileRename(stmt, perf, datasetId, relOldPath, relNewPath, st, snapId, oldFile, victim) {
	const type = typeFromStat(st);

	if (oldFile === undefined) {
		oldFile = stmt.getFileByPath.get(datasetId, relOldPath) ?? null;
		perf.sqlSelects++;
	}

	if (!oldFile) {
		const fileRow = stmt.upsertFile.get(datasetId, relNewPath, st.ino, type, snapId, snapId);
		perf.sqlUpserts++;
		if (fileRow) {
			insertVersionFromStat(stmt, perf, fileRow.id, snapId, st);
		}
		return { fileId: fileRow?.id ?? null, oldSize: null };
	}

	const oldSize = oldFile.latestSize ?? null;

	if (victim === undefined) {
		victim = stmt.getFileByPath.get(datasetId, relNewPath) ?? null;
		perf.sqlSelects++;
	}
	if (victim && victim.id !== oldFile.id) {
		stmt.deleteChangesByFileId.run(victim.id);
		stmt.deleteVersionsByFileId.run(victim.id);
		stmt.deleteFileById.run(victim.id);
	}

	stmt.updateFileRename.run(relNewPath, st.ino, type, snapId, oldFile.id, datasetId);
	perf.sqlUpdates++;
	insertVersionFromStat(stmt, perf, oldFile.id, snapId, st);
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

	const { results, failures } = await batchStat(entries, STAT_CONCURRENCY);
	const map = new Map();
	for (let j = 0; j < entries.length; j++) {
		map.set(entries[j].idx, results[j]);
	}
	return { map, statTotal: entries.length, statFailures: failures };
}

/**
 * Resolve all (rel old, rel new) paths for a batch up front and return them
 * along with the set of paths that need a DB lookup. We need to look up:
 *  - the existing row for removed/modified/renamed sources (oldSize, fileId)
 *  - the victim row at the rename target (so we can vacuum it cleanly)
 */
function resolveBatchPaths(batch, mountpoint, { lookupAllSources = false } = {}) {
	const relPaths = new Array(batch.length);
	const relNewPaths = new Array(batch.length);
	const lookup = new Set();
	for (let i = 0; i < batch.length; i++) {
		const c = batch[i];
		const relPath = resolveRelPath(c.path, mountpoint);
		relPaths[i] = relPath;
		if (lookupAllSources || c.changeType !== 'added') {
			lookup.add(relPath);
		}
		if (c.changeType === 'renamed') {
			const relNewPath = resolveRelPath(c.newPath, mountpoint);
			relNewPaths[i] = relNewPath;
			lookup.add(relNewPath);
		} else {
			relNewPaths[i] = null;
		}
	}
	return { relPaths, relNewPaths, lookup };
}

function bulkLoadFileMap(stmt, perf, datasetId, paths) {
	if (!paths.size) {
		return new Map();
	}
	const t = Date.now();
	const rows = stmt.bulkLookupFiles.all(JSON.stringify([...paths]), datasetId);
	perf.sqlSelects += rows.length;
	perf.sqlMs += Date.now() - t;
	const map = new Map();
	for (const r of rows) {
		map.set(r.path, { id: r.id, latestSize: r.latest_size ?? null });
	}
	return map;
}

function bulkLoadFileMapWithSnap(stmt, perf, datasetId, paths, snapId) {
	if (!paths.size) {
		return new Map();
	}
	const t = Date.now();
	const rows = stmt.bulkLookupFilesWithSnap.all(JSON.stringify([...paths]), datasetId, snapId);
	perf.sqlSelects += rows.length;
	perf.sqlMs += Date.now() - t;
	const map = new Map();
	for (const r of rows) {
		map.set(r.path, {
			id: r.id,
			latestSize: r.latest_size ?? null,
			sizeAtSnap: r.size_at_snap ?? null,
		});
	}
	return map;
}

// ─── Batch flush: incremental only ─────────────────────────────────────────

async function flushIncrementalBatch(db, stmt, perf, batch, snap, datasetId, mountpoint, snapPath) {
	const { statMap, relPaths, relNewPaths, fileByPath } = await prepareIncrementalFlushContext(
		batch, snap, snapPath, mountpoint, perf, datasetId, stmt
	);

	const t = Date.now();
	database.transaction(db, () => {
		perf.sqlTxns++;
		for (let i = 0; i < batch.length; i++) {
			const c = batch[i];
			const relPath = relPaths[i];

			if (c.changeType === 'added') {
				const st = statMap.get(i);
				if (st) {
					const type = typeFromStat(st);
					const fileRow = stmt.upsertFile.get(datasetId, relPath, st.ino, type, snap.id, snap.id);
					perf.sqlUpserts++;
					if (fileRow) {
						const newSize = insertVersionFromStat(stmt, perf, fileRow.id, snap.id, st);
						fileByPath.set(relPath, { id: fileRow.id, latestSize: newSize });
					}
				}
			} else if (c.changeType === 'removed') {
				const fileRow = fileByPath.get(relPath);
				if (fileRow) { stmt.markDeleted.run(snap.id, fileRow.id); perf.sqlUpdates++; }
			} else if (c.changeType === 'modified') {
				const st = statMap.get(i);
				if (st) {
					let fileRow = fileByPath.get(relPath);
					if (!fileRow) {
						const r = upsertFileFromStat(stmt, perf, datasetId, relPath, st, snap.id);
						if (r.fileRow) {
							fileRow = { id: r.fileRow.id, latestSize: r.newSize };
							fileByPath.set(relPath, fileRow);
						}
					} else {
						fileRow.latestSize = insertVersionFromStat(stmt, perf, fileRow.id, snap.id, st);
					}
				}
			} else if (c.changeType === 'renamed') {
				const st = statMap.get(i);
				if (st) {
					const relNewPath = relNewPaths[i];
					const oldFile = fileByPath.get(relPath) ?? null;
					const victim = fileByPath.get(relNewPath) ?? null;
					const { fileId: rid } = applyFileRename(stmt, perf, datasetId, relPath, relNewPath, st, snap.id, oldFile, victim);
					syncMapForRename(fileByPath, relPath, relNewPath, oldFile, victim, rid, sizeFromStat(st));
				}
			}
		}
	});
	perf.sqlMs += Date.now() - t;
}

// ─── Batch flush: unified incremental + diff ────────────────────────────────

async function flushUnifiedBatch(db, stmt, perf, batch, snap, datasetId, mountpoint, snapPath) {
	const { statMap, relPaths, relNewPaths, fileByPath } = await prepareIncrementalFlushContext(
		batch, snap, snapPath, mountpoint, perf, datasetId, stmt
	);

	const t = Date.now();
	database.transaction(db, () => {
		perf.sqlTxns++;
		for (let i = 0; i < batch.length; i++) {
			const c = batch[i];
			const relPath = relPaths[i];
			const relNewPath = relNewPaths[i];
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
						newSize = insertVersionFromStat(stmt, perf, fileRow.id, snap.id, st);
						fileByPath.set(relPath, { id: fileRow.id, latestSize: newSize });
					}
				}
			} else if (c.changeType === 'removed') {
				const fileRow = fileByPath.get(relPath);
				if (fileRow) {
					fileId = fileRow.id;
					oldSize = fileRow.latestSize;
					stmt.markDeleted.run(snap.id, fileId);
					perf.sqlUpdates++;
				}
			} else if (c.changeType === 'modified') {
				if (st) {
					let fileRow = fileByPath.get(relPath);
					if (!fileRow) {
						const r = upsertFileFromStat(stmt, perf, datasetId, relPath, st, snap.id);
						if (r.fileRow) {
							fileRow = { id: r.fileRow.id, latestSize: r.newSize };
							fileByPath.set(relPath, fileRow);
							fileId = fileRow.id;
							oldSize = null; // we just created the row; no prior version to diff against
							newSize = r.newSize;
						}
					} else {
						fileId = fileRow.id;
						oldSize = fileRow.latestSize;
						newSize = insertVersionFromStat(stmt, perf, fileRow.id, snap.id, st);
						fileRow.latestSize = newSize;
					}
				}
			} else if (c.changeType === 'renamed') {
				if (st) {
					newSize = sizeFromStat(st);
					const oldFile = fileByPath.get(relPath) ?? null;
					const victim = fileByPath.get(relNewPath) ?? null;
					const { fileId: rid, oldSize: rold } = applyFileRename(stmt, perf, datasetId, relPath, relNewPath, st, snap.id, oldFile, victim);
					fileId = rid;
					oldSize = rold;
					syncMapForRename(fileByPath, relPath, relNewPath, oldFile, victim, rid, newSize);
				}
			}

			if (fileId === null) {
				perf.orphanedChanges++;
				sampleOrphan(perf, snap, c.changeType, relPath, relNewPath, st === null, 'unified');
				continue;
			}

			const delta = (newSize !== null || oldSize !== null) ? (newSize ?? 0) - (oldSize ?? 0) : null;
			stmt.insertChange.run(snap.id, fileId, c.changeType, relPath, relNewPath, oldSize, newSize, delta);
			perf.sqlInserts++;
			perf.diffChanges++;
		}
	});
	perf.sqlMs += Date.now() - t;
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

function flushChanges(db, stmt, perf, changes, snap, datasetId, mountpoint) {
	const { relPaths, relNewPaths, lookup } = resolveBatchPaths(changes, mountpoint, { lookupAllSources: true });
	const fileByPath = bulkLoadFileMapWithSnap(stmt, perf, datasetId, lookup, snap.id);

	const t = Date.now();
	database.transaction(db, () => {
		perf.sqlTxns++;
		for (let i = 0; i < changes.length; i++) {
			const c = changes[i];
			const relPath = relPaths[i];
			const relNewPath = relNewPaths[i];

			const fileRow = fileByPath.get(relPath) ?? null;
			const fileId = fileRow?.id ?? null;

			let oldSize = null;
			let newSize = null;
			if (c.changeType === 'removed') {
				oldSize = fileRow?.latestSize ?? null;
			} else if (c.changeType === 'added') {
				newSize = fileRow?.sizeAtSnap ?? null;
			} else {
				oldSize = fileRow?.latestSize ?? null;
				newSize = fileRow?.sizeAtSnap ?? null;
			}

			if (c.changeType === 'removed' && fileId) { stmt.markDeleted.run(snap.id, fileId); perf.sqlUpdates++; }

			if (fileId === null) {
				perf.orphanedChanges++;
				sampleOrphan(perf, snap, c.changeType, relPath, relNewPath, false, 'changes');
				continue;
			}

			const delta = (newSize !== null || oldSize !== null) ? (newSize ?? 0) - (oldSize ?? 0) : null;
			stmt.insertChange.run(snap.id, fileId, c.changeType, relPath, c.changeType === 'renamed' ? relNewPath : null, oldSize, newSize, delta);
			perf.sqlInserts++;
			perf.diffChanges++;
		}
	});
	perf.sqlMs += Date.now() - t;
}

// ─── Stats ──────────────────────────────────────────────────────────────────

/**
 * Returns a `{ added, modified, renamed, removed, unknown }` counter object
 * pulled from `changes.change_type`. Missing types are filled with 0 so the
 * shape is stable across runs (handy for diffing or JSON consumers).
 */
function changeTypeBreakdown(db) {
	const counts = { added: 0, modified: 0, renamed: 0, removed: 0, unknown: 0 };
	const rows = db.prepare('SELECT change_type, COUNT(*) AS n FROM changes GROUP BY change_type').all();
	for (const r of rows) {
		if (Object.prototype.hasOwnProperty.call(counts, r.change_type)) {
			counts[r.change_type] = r.n;
		} else {
			counts.unknown += r.n;
		}
	}
	return counts;
}

function printStats(db, perf, sessionWallT0 = null, restartCount = 0) {
	const totalMs =
		(sessionWallT0 !== null && sessionWallT0 !== undefined) ? Date.now() - sessionWallT0 : Date.now() - perf.t0;
	const stats = db.prepare(`SELECT (SELECT COUNT(*) FROM datasets) AS datasets, (SELECT COUNT(*) FROM snapshots) AS snapshots, (SELECT COUNT(*) FROM files) AS files, (SELECT COUNT(*) FROM file_versions) AS versions, (SELECT COUNT(*) FROM changes) AS changes, (SELECT COUNT(*) FROM files WHERE deleted_at_snap_id IS NOT NULL) AS deleted`).get();
	const changeBreakdown = changeTypeBreakdown(db);

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
	console.log(`  added:    ${changeBreakdown.added.toLocaleString()}`);
	console.log(`  modified: ${changeBreakdown.modified.toLocaleString()}`);
	console.log(`  renamed:  ${changeBreakdown.renamed.toLocaleString()}`);
	console.log(`  removed:  ${changeBreakdown.removed.toLocaleString()}`);
	if (changeBreakdown.unknown > 0) {
		console.log(`  unknown:  ${changeBreakdown.unknown.toLocaleString()}`);
	}
	console.log(`Deleted files: ${stats.deleted.toLocaleString()}`);

	const backfilled = perf.backfilledFiles ?? 0;
	if (backfilled > 0) {
		console.log(`\n♻  Self-repaired this run: ${backfilled.toLocaleString()} file row(s) backfilled (paths zfs-diff reported but we had no row for; usually files born after the baseline crawl).`);
	}

	const anyFailures = perf.orphanedChanges > 0 || perf.statFailures > 0 || perf.failedSnapshots.length > 0 || restartCount > 0;
	if (anyFailures) {
		console.log('\n⚠  Failures (this run):');
		console.log(`Orphan changes skipped: ${perf.orphanedChanges.toLocaleString()}`);
		console.log(`Stat failures:          ${perf.statFailures.toLocaleString()}`);
		console.log(`Restarts:               ${restartCount}`);
		console.log(`Failed snapshots:       ${perf.failedSnapshots.length}`);
		for (const f of perf.failedSnapshots.slice(0, 5)) {
			console.log(`  • ${f.name} (${f.reason})`);
		}
		if (perf.failedSnapshots.length > 5) {
			console.log(`  …and ${perf.failedSnapshots.length - 5} more`);
		}
		const samples = perf.orphanSamplesAll ?? [];
		if (samples.length > 0) {
			console.log('Orphan samples:');
			for (const s of samples.slice(0, 10)) {
				const snap = s.snapshot ? ` @${s.snapshot}` : '';
				console.log(`  · [${s.type}/${s.cause}]${snap} ${s.path}`);
			}
			if (perf.orphanedChanges > samples.length) {
				console.log(`  …and ${(perf.orphanedChanges - samples.length).toLocaleString()} more (not sampled)`);
			}
		}
	}

	console.log('\n💾 SQLite:');
	console.log(`DB size: ${utils.formatSize(pgSz * pgCount)}`);
	console.log(`Used: ${utils.formatSize(pgSz * (pgCount - pgFree))} (${pgCount - pgFree} pages)`);
	console.log(`Free: ${utils.formatSize(pgSz * pgFree)} (${pgFree} pages)`);
	console.log(`Page size: ${utils.formatSize(pgSz)}`);
	console.log(`Journal mode: ${jMode}`);
	console.log(`Cache size: ${Math.abs(cSz)}${cSz < 0 ? 'KiB' : ' pages'}`);

	console.log('\n⏱  Performance:');
	console.log(`Total runtime: ${utils.formatDuration(totalMs)}`);
	if (restartCount > 0) {
		console.log(`Restarts: ${restartCount}`);
		console.log('Note: Crawl/diff/SQL counters below are for the last completed pass only.');
	}
	console.log(`Crawl time: ${utils.formatDuration(perf.crawlMs)}`);
	console.log(`Diff time: ${utils.formatDuration(perf.diffMs)}`);
	console.log(`Stat time: ${utils.formatDuration(perf.statMs)}`);
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
	console.log(`SQL time: ${utils.formatDuration(perf.sqlMs)}`);
	if (totalMs > 0) {
		console.log(`SQL % of total: ${(perf.sqlMs / totalMs * 100).toFixed(1)}%`);
	}
	if (perf.sqlMs > 0 && totalOps > 0) {
		console.log(`SQL ops/s: ${(totalOps / (perf.sqlMs / 1000)).toFixed(0)}`);
		console.log(`Avg per op: ${(perf.sqlMs / totalOps * 1000).toFixed(1)}μs`);
	}
}

export { run, changeTypeBreakdown };
