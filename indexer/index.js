import DataService from '../src/database/data_service.js';
import * as database from './db.js';
import * as zfs from './zfs.js';
import * as walker from './walker.js';
import * as utils from './utils.js';
import { execaSync } from 'execa';
import { BATCH_SIZE } from './constants.js';
import { isNoisePath, NOISE_SCOPE_VERSION } from './scope.js';
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
	let recoverable = zfs.isZfsDiffFailure(e) || isSnapshotStatFailure(e);
	// Retention taking a snapshot away is routine on a node that snapshots hourly
	// and indexes for half an hour. Counting it as a failed snapshot put it in the
	// failures list and the "not an error" line at the same time.
	let wasVanished = false;
	const transition = prevSnap ? `${prevSnap.name} → ${snap.name}` : snap.name;

	// Snapshot retention running against a long pass is the common cause of a
	// failed diff, and a full restart is the wrong answer for it: the pair is
	// simply gone. Skip it and let the next pass prune it during discovery,
	// instead of throwing away every snapshot already done this pass.
	if (zfs.isZfsDiffFailure(e)) {
		const vanished = [prevSnap?.full_name, snap.full_name]
			.filter(Boolean)
			.find(name => !zfs.snapshotExists(name));
		if (vanished) {
			console.warn(`  ⚠  ${vanished} no longer exists — retention removed it mid-run; skipping this pair rather than restarting.`);
			perf.vanishedSnapshots = (perf.vanishedSnapshots ?? 0) + 1;
			(perf.vanishedList ??= []).push({ fullName: vanished, datasetId });
			recoverable = false;
			wasVanished = true;
		}
	}
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
	if (!wasVanished && perf && Array.isArray(perf.failedSnapshots)) {
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
	// A restart only helps when the cause was a race (retention, a lagging
	// automount). If the same snapshot fails again the cause is deterministic, and
	// restarting just burns whole passes until the attempt budget runs out — so
	// skip it instead and let the rest of the run finish.
	const key = snap.full_name ?? snap.name;
	const alreadyRestarted = perf?.restartedSnapshots?.has(key);
	if (recoverable && !alreadyRestarted) {
		perf?.restartedSnapshots?.add(key);
		restartIndexerFromBeginning(
			`${e.code} on ${snap.name}; restarting from beginning so retention/deleted snapshots are re-discovered.`
		);
	}
	if (recoverable) {
		console.warn(`  ⚠  ${snap.name} failed again after a restart; skipping it for this run.`);
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
		getMeta: db.prepare(`SELECT value FROM meta WHERE key = ?`),
		setMeta: db.prepare(`
			INSERT INTO meta(key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`),
		deleteMeta: db.prepare(`DELETE FROM meta WHERE key = ?`),
	};
}

// How many consecutive runs a dataset may be missing from `zfs list` before its
// index is dropped. An exported pool, an unmounted dataset or a transient zfs
// hiccup should not cost a full re-crawl; a real destroy still clears within a
// few hours on the hourly schedule.
const MISSING_RUNS_BEFORE_DROP = 3;

/**
 * Remove SQLite rows for datasets that are no longer indexed:
 * - name not under current Configuration `indexer` list — dropped immediately,
 *   because that is a deliberate user action, or
 * - still in scope but not returned by ZFS for several consecutive runs.
 */
function pruneStaleIndexedDatasets(db, stmt, includeDatasets, liveNames) {
	const rows = db.prepare('SELECT id, name FROM datasets').all();
	for (const { id, name } of rows) {
		const inScope = datasetInIncludeScope(name, includeDatasets);
		const onZfs = liveNames.has(name);
		const missingKey = `missing_runs:${name}`;

		if (inScope && onZfs) {
			stmt.deleteMeta.run(missingKey);
			continue;
		}

		if (inScope && !onZfs) {
			const misses = Number(stmt.getMeta.get(missingKey)?.value ?? 0) + 1;
			if (misses < MISSING_RUNS_BEFORE_DROP) {
				console.log(`  ⏳ ${name} not reported by ZFS (${misses}/${MISSING_RUNS_BEFORE_DROP}); keeping its index for now.`);
				database.transaction(db, () => {
					stmt.setMeta.run(missingKey, String(misses));
				});
				continue;
			}
		}

		const reason = !inScope ? 'removed from indexer configuration' : `absent from ZFS for ${MISSING_RUNS_BEFORE_DROP} runs`;
		console.log(`  🗑  Dropping index data for ${name} (${reason})`);
		database.transaction(db, () => {
			stmt.deleteChangesForDataset.run(id);
			stmt.deleteFileVersionsForDataset.run(id);
			stmt.deleteFilesForDataset.run(id);
			stmt.deleteSnapshotsForDataset.run(id);
			stmt.deleteDatasetById.run(id);
			stmt.deleteMeta.run(missingKey);
		});
	}
}

/**
 * Drop snapshots ZFS no longer reports.
 *
 * A file that hasn't changed since the baseline crawl has exactly one
 * `file_versions` row — the baseline one. Deleting a pruned snapshot's versions
 * outright would orphan every such file, `deleteOrphanedFiles` would remove it,
 * and nothing would rebuild it: only a dataset's *first* snapshot takes the
 * full-crawl path. Retention expiring the baseline would silently empty the
 * index for good.
 *
 * So re-anchor onto the next surviving snapshot instead — a file live at the
 * pruned snapshot was still live there. Files deleted in between are left to
 * orphan out: their last remaining evidence is going away, so there is nothing
 * left to recover and nothing worth listing.
 */
function pruneDeletedSnapshots(db, stmt, filteredDatasets, datasetIds, liveFullNames) {
	let pruned = 0;
	for (const d of filteredDatasets) {
		const dsId = datasetIds[d.name];
		const dsSnaps = stmt.getSnapshotsForDataset.all(dsId);
		for (let i = 0; i < dsSnaps.length; i++) {
			const snap = dsSnaps[i];
			if (liveFullNames.has(snap.full_name)) {
				continue;
			}
			const survivor = dsSnaps.slice(i + 1).find(s => liveFullNames.has(s.full_name)) ?? null;
			console.log(`  🗑  Pruning: ${snap.full_name}${survivor ? ` (versions re-anchored to ${survivor.name})` : ''}`);
			pruneSnapshotRow(db, stmt, snap, survivor);
			pruned++;
		}
	}
	return pruned;
}

/**
 * Delete rows for paths the current noise patterns exclude.
 *
 * The walker and the diff filter only stop noise from being *added*; anything
 * indexed under an older, narrower pattern stays forever. Runs only when the
 * stored NOISE_SCOPE_VERSION differs, because it is a full scan of `files`.
 *
 * Matching happens in JS rather than SQL: the patterns allow a subtree at any
 * depth, which no single LIKE expresses without over-matching real user paths.
 */
function purgeNoiseRows(db, stmt, filteredDatasets, datasetIds) {
	let removed = 0;
	for (const d of filteredDatasets) {
		const dsId = datasetIds[d.name];
		let batch = [];
		const flush = () => {
			if (!batch.length) {
				return;
			}
			const list = JSON.stringify(batch);
			database.transaction(db, () => {
				stmt.deleteChangesByFileIds.run(list);
				stmt.deleteVersionsByFileIds.run(list);
				stmt.deleteFilesByIds.run(list);
			});
			removed += batch.length;
			batch = [];
		};
		for (const row of stmt.iterateFilePaths.iterate(dsId)) {
			if (isNoisePath(row.path)) {
				batch.push(row.id);
				if (batch.length >= BATCH_SIZE) {
					flush();
				}
			}
		}
		flush();
	}
	return removed;
}

/** Drop one snapshot row, moving its versions onto `survivor` first (see above). */
function pruneSnapshotRow(db, stmt, snap, survivor) {
	database.transaction(db, () => {
		stmt.deleteChangesBySnapshot.run(snap.id);
		if (survivor) {
			stmt.reanchorVersions.run(survivor.id, snap.id);
		}
		stmt.deleteVersionsBySnapshot.run(snap.id);
		stmt.clearFirstSeen.run(snap.id);
		stmt.clearLastSeen.run(snap.id);
		stmt.clearDeletedAt.run(snap.id);
		stmt.deleteSnapshot.run(snap.id);
	});
}

/**
 * Remove rows for snapshots retention destroyed while the pass was running.
 *
 * Without this they linger as unindexed rows until the next pass rediscovers
 * them, so a completed run still reports "233 snapshots, 231 indexed" — the
 * dashboard reads that as work outstanding when there is none.
 */
function pruneVanishedSnapshots(db, stmt, perf) {
	const pending = perf.vanishedList ?? [];
	let pruned = 0;
	// Survivors come from the vanished set, not from re-probing ZFS: a probe that
	// fails for any reason would report "no survivor", and no survivor means the
	// versions get deleted instead of re-anchored.
	const vanishedNames = new Set(pending.map(p => p.fullName));
	for (const { fullName, datasetId } of pending) {
		const dsSnaps = stmt.getSnapshotsForDataset.all(datasetId);
		const idx = dsSnaps.findIndex(s => s.full_name === fullName);
		if (idx === -1) {
			continue;
		}
		const survivor = dsSnaps.slice(idx + 1).find(s => !vanishedNames.has(s.full_name)) ?? null;
		console.log(`  🗑  Removing ${fullName} (destroyed mid-run)${survivor ? ` — versions re-anchored to ${survivor.name}` : ''}`);
		pruneSnapshotRow(db, stmt, dsSnaps[idx], survivor);
		pruned++;
	}
	perf.vanishedList = [];
	return pruned;
}

/**
 * A dataset with snapshots but no files can only be refilled by a full crawl,
 * and that path is reachable only for its first snapshot — so without this the
 * index could settle into a permanently empty state. Clearing `indexed_at` on
 * the oldest survivor makes the next pass rebuild the baseline.
 */
function forceBaselineRecrawl(db, stmt, filteredDatasets, datasetIds) {
	for (const d of filteredDatasets) {
		const dsId = datasetIds[d.name];
		if (stmt.datasetHasFiles.get(dsId)) {
			continue;
		}
		const oldest = stmt.oldestSnapshotForDataset.get(dsId);
		if (!oldest || !oldest.indexed_at) {
			continue;
		}
		console.log(`  ♻  ${d.name} has snapshots but no indexed files; forcing a fresh baseline crawl of ${oldest.name}.`);
		stmt.resetSnapshotIndexState.run(oldest.id);
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
		stmt.setMeta.run('last_run_renamed_subtree_paths', String(perf.renamedSubtreePaths ?? 0));
		stmt.setMeta.run('last_run_overwritten_files', String(perf.overwrittenFiles ?? 0));
		stmt.setMeta.run('last_run_vanished_snapshots', String(perf.vanishedSnapshots ?? 0));
	});
}

/**
 * A run that exhausts its restart budget never reaches finishIndexerRun, so
 * without this the dashboard would keep showing the previous run as the latest —
 * healthy-looking, hours after the indexer gave up.
 */
function recordFailedSession(session, restartCount) {
	const perf = session.lastPerf;
	if (!perf) {
		return;
	}
	const db = database.open();
	if (!db) {
		return;
	}
	try {
		const stmt = {
			setMeta: db.prepare(`
				INSERT INTO meta(key, value) VALUES (?, ?)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value
			`),
		};
		persistLastRunMeta(db, stmt, perf, restartCount);
	} catch (e) {
		console.warn(`  ⚠  Could not record the failed run: ${e.message}`);
	} finally {
		db.close();
	}
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

/**
 * Returns the configured dataset roots, or `null` if the key is present but not
 * an array. An empty result means "index nothing" and clears the database, so a
 * malformed value must be distinguishable — otherwise a config typo silently
 * costs a full re-crawl.
 */
function normalizeIndexerDatasets(configuration) {
	const raw = configuration?.indexer;
	if (raw === null || raw === undefined) {
		return [];
	}
	if (!Array.isArray(raw)) {
		return null;
	}
	return raw.map(s => String(s).trim()).filter(Boolean);
}

async function run(_opts = {}) {
	// Nowhere to keep an index means nothing to index: no pool, or one setup has not prepared yet.
	const index = database.open();
	if (!index) {
		return;
	}
	
	index.close();

	const staleTemps = zfs.cleanupStaleTempFiles();
	if (staleTemps > 0) {
		console.log(`🧹 Cleaned up ${staleTemps} stale zfs-diff temp file(s) from previous run(s).`);
	}

	const configuration = await DataService.getConfiguration();
	const includeDatasets = normalizeIndexerDatasets(configuration);

	if (includeDatasets === null) {
		console.error(
			'Indexer: Configuration key `indexer` is present but not a JSON array (virgo.db). Refusing to run — fix the value rather than lose the index to a typo.'
		);
		process.exitCode = 1;
		return;
	}

	if (!includeDatasets.length) {
		console.log(
			'Indexer: Configuration key `indexer` is missing or empty (virgo.db); clearing the index database.'
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
		// Survives restarts: which snapshots have already cost us a full pass, and
		// the last pass's counters so a fatal exit still records what happened.
		const session = { restartedSnapshots: new Set(), perf: null, lastPerf: null };

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (attempt > 0) {
				console.log(`\n↻ Restarting indexer from the beginning (attempt ${attempt + 1}/${maxAttempts})…\n`);
			}
			try {
				await runIndexerPass(includeDatasets, sessionWallT0, attempt, lockPath, session);
				return;
			} catch (e) {
				if (e.code !== 'INDEXER_RESTART_FROM_BEGINNING') {
					throw e;
				}
				if (attempt + 1 >= maxAttempts) {
					console.error(`Fatal: zfs diff still failing after ${maxAttempts} full restarts.`);
					recordFailedSession(session, attempt);
					process.exitCode = 1;
					throw e;
				}
			}
		}
	} finally {
		utils.releaseLock(lockPath);
	}
}

/** Every prepared statement a pass uses. Split out so tests can drive the real ones. */
function prepareIndexerStatements(db) {
	return {
		upsertDataset: db.prepare(`INSERT INTO datasets(name, pool, mountpoint, created_at) VALUES(?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET mountpoint=excluded.mountpoint RETURNING id`),
		upsertSnapshot: db.prepare(`INSERT INTO snapshots(dataset_id, name, full_name, created_at, used_bytes, referenced_bytes) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(full_name) DO UPDATE SET used_bytes=excluded.used_bytes, referenced_bytes=excluded.referenced_bytes RETURNING id`),
		getSnapshotsForDataset: db.prepare(`SELECT id, name, full_name, created_at, indexed_at, diff_done FROM snapshots WHERE dataset_id=? ORDER BY created_at ASC, id ASC`),
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
		// `zfs diff` emits a single R line for a renamed directory — the children are
		// untouched objects and produce no lines at all — so the subtree has to be
		// rewritten by hand or every descendant path goes stale for good.
		renameSubtree: db.prepare(`
			UPDATE files SET path = ?1 || substr(path, ?2) WHERE dataset_id = ?3 AND path LIKE ?4 ESCAPE '\\'
		`),
		deleteChangesUnderPath: db.prepare(`
			DELETE FROM changes WHERE file_id IN (SELECT id FROM files WHERE dataset_id = ?1 AND path LIKE ?2 ESCAPE '\\')
		`),
		deleteVersionsUnderPath: db.prepare(`
			DELETE FROM file_versions WHERE file_id IN (SELECT id FROM files WHERE dataset_id = ?1 AND path LIKE ?2 ESCAPE '\\')
		`),
		deleteFilesUnderPath: db.prepare(`
			DELETE FROM files WHERE dataset_id = ?1 AND path LIKE ?2 ESCAPE '\\'
		`),
		tombstoneOverwrittenFile: db.prepare(`
			UPDATE files SET path = ?1, deleted_at_snap_id = ?2, overwritten_from = ?4 WHERE id = ?3
		`),
		insertChange: db.prepare(`INSERT INTO changes(snapshot_id, file_id, change_type, old_path, new_path, old_size, new_size, delta_bytes, changed_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`),
		bumpLastSeen: db.prepare(`UPDATE files SET last_seen_snap_id = ? WHERE dataset_id = ? AND deleted_at_snap_id IS NULL`),
		deleteChangesBySnapshot: db.prepare(`DELETE FROM changes WHERE snapshot_id = ?`),
		deleteVersionsBySnapshot: db.prepare(`DELETE FROM file_versions WHERE snapshot_id = ?`),
		clearFirstSeen: db.prepare(`UPDATE files SET first_seen_snap_id = NULL WHERE first_seen_snap_id = ?`),
		clearLastSeen: db.prepare(`UPDATE files SET last_seen_snap_id = NULL WHERE last_seen_snap_id = ?`),
		clearDeletedAt: db.prepare(`UPDATE files SET deleted_at_snap_id = NULL WHERE deleted_at_snap_id = ?`),
		deleteSnapshot: db.prepare(`DELETE FROM snapshots WHERE id = ?`),
		// OR IGNORE skips rows that collide with a version the file already has at
		// the survivor — those are redundant; deleteVersionsBySnapshot sweeps them.
		reanchorVersions: db.prepare(`
			UPDATE OR IGNORE file_versions SET snapshot_id = ?1
			WHERE snapshot_id = ?2
			AND EXISTS (
				SELECT 1 FROM files f WHERE f.id = file_versions.file_id AND f.deleted_at_snap_id IS NULL
			)
		`),
		datasetHasFiles: db.prepare(`SELECT 1 AS present FROM files WHERE dataset_id = ? LIMIT 1`),
		iterateFilePaths: db.prepare(`SELECT id, path FROM files WHERE dataset_id = ?`),
		deleteChangesByFileIds: db.prepare(`DELETE FROM changes WHERE file_id IN (SELECT value FROM json_each(?1))`),
		deleteVersionsByFileIds: db.prepare(`DELETE FROM file_versions WHERE file_id IN (SELECT value FROM json_each(?1))`),
		deleteFilesByIds: db.prepare(`DELETE FROM files WHERE id IN (SELECT value FROM json_each(?1))`),
		oldestSnapshotForDataset: db.prepare(`
			SELECT id, name, indexed_at FROM snapshots WHERE dataset_id = ? ORDER BY created_at ASC, id ASC LIMIT 1
		`),
		resetSnapshotIndexState: db.prepare(`UPDATE snapshots SET indexed_at = NULL, diff_done = 0 WHERE id = ?`),
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
	};
}

async function runIndexerPass(includeDatasets, sessionWallT0 = null, restartCount = 0, lockPath = null, session = null) {
	// Every distinct pool the configured roots live in. Discovering only the first
	// one left datasets on any other pool invisible — never indexed, and dropped
	// from the index as "no longer present on ZFS" on every pass.
	const pools = [...new Set(includeDatasets.map(name => name.split('/')[0]))];

	const db = database.open();

	// Reused across restarts: a pass that fails late has still done real work, and
	// discarding its counters made the summary describe seconds of a run that took
	// half an hour.
	const perf = session?.perf ?? {
		t0: Date.now(), snapsCrawled: 0, snapsIncremental: 0, snapsSkipped: 0,
		diffsDone: 0, filesCrawled: 0, crawlMs: 0, incrMs: 0, diffMs: 0,
		sqlInserts: 0, sqlUpserts: 0, sqlSelects: 0, sqlUpdates: 0, sqlTxns: 0, sqlMs: 0,
		diffChanges: 0, statMs: 0,
		statFailures: 0, orphanedChanges: 0,
		// Count of `files` rows created on the fly because `zfs diff` reported a
		// change for a path we hadn't indexed yet. A small steady number is fine
		// (logs/caches appearing post-baseline); a sudden spike hints at gaps in
		// the walker output.
		backfilledFiles: 0,
		// Descendant paths rewritten because zfs diff reported a directory rename;
		// the children produce no diff lines of their own.
		renamedSubtreePaths: 0,
		purgedNoiseRows: 0,
		// Files destroyed by a rename landing on top of them; tombstoned, not dropped.
		overwrittenFiles: 0,
		crawlSkippedDirs: 0,
		// Snapshots retention destroyed while the pass was running.
		vanishedSnapshots: 0,
		// Per-snapshot samples reset by reportSnapshotAnomalies; per-run samples
		// accumulate across the entire pass and get persisted to meta so the
		// dashboard + CLI summary can show actual offending paths after a run.
		orphanSamples: [],
		orphanSamplesAll: [],
		failedSnapshots: [],
		// Shared across restarts so a snapshot that fails deterministically only
		// costs one pass. See handleSnapshotError.
		restartedSnapshots: session?.restartedSnapshots ?? new Set(),
	};
	if (session) {
		session.perf = perf;
		session.lastPerf = perf;
	}
	// Per-snapshot sample buffer must not carry over between passes.
	perf.orphanSamples = [];

	const stmt = prepareIndexerStatements(db);

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
		console.log(`   Pool${pools.length === 1 ? '' : 's'}: ${pools.join(', ')}`);
		console.log(`   Include: ${includeDatasets.join(', ')}`);

		const datasets = [];
		const snapshots = [];
		for (const pool of pools) {
			const found = zfs.discoverAll({ pool });
			datasets.push(...found.datasets);
			snapshots.push(...found.snapshots);
		}
		snapshots.sort((a, b) => a.created_at - b.created_at);
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

		for (const s of snapshots) {
			const dsId = datasetIds[s.dataset_name];
			if (!dsId) {
				continue;
			}
			stmt.upsertSnapshot.run(dsId, s.name, s.full_name, s.created_at, s.used_bytes, s.referenced_bytes);
		}

		// Prune deleted snapshots
		const liveFullNames = new Set(snapshots.map(s => s.full_name));
		const prunedSnapshots = pruneDeletedSnapshots(db, stmt, filteredDatasets, datasetIds, liveFullNames);
		// Two full scans of `files` with a NOT EXISTS probe each. Only pruning can
		// orphan a row, so a steady-state pass has nothing to find.
		if (prunedSnapshots > 0) {
			database.transaction(db, () => {
				for (const d of filteredDatasets) {
					const dsId = datasetIds[d.name];
					stmt.repairLastSeenNull.run(dsId);
					stmt.repairFirstSeenNull.run(dsId);
				}
				stmt.deleteChangesForOrphanedFiles.run();
				stmt.deleteOrphanedFiles.run();
			});
			database.vacuumIfBloated(db);
		}
		forceBaselineRecrawl(db, stmt, filteredDatasets, datasetIds);

		const storedScope = Number(stmt.getMeta.get('noise_scope_version')?.value ?? 0);
		let purgedNoise = 0;
		if (storedScope !== NOISE_SCOPE_VERSION) {
			console.log(`  🧹 Noise patterns changed (v${storedScope} → v${NOISE_SCOPE_VERSION}); sweeping rows they now exclude…`);
			purgedNoise = purgeNoiseRows(db, stmt, filteredDatasets, datasetIds);
			perf.purgedNoiseRows = purgedNoise;
			console.log(`     Removed ${purgedNoise.toLocaleString()} row(s).`);
			database.transaction(db, () => {
				stmt.setMeta.run('noise_scope_version', String(NOISE_SCOPE_VERSION));
			});
			if (purgedNoise > 0) {
				database.vacuumIfBloated(db);
			}
		}

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
		// A noise purge deletes a lot of `files` rows; letting the FTS triggers fire
		// per row costs far more than one rebuild at the end.
		const needBulkMode = !ftsTriggersPresent(db)
			|| purgedNoise > 0
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
			// `changes` rows must describe the delta from a snapshot's *immediate*
			// predecessor. When one is skipped, prevSnap deliberately stays on the
			// last good snapshot so indexing can continue — but any diff written
			// from there would span the gap and then overlap the skipped snapshot's
			// own rows once it is retried. So index across the gap, record no
			// changes, and leave diff_done clear for a later pass to fill in.
			let prevSnapIsImmediate = true;
			let snapIdx = 0;
			for (const snap of dsSnaps) {
				try {
					const snapPath = zfs.snapshotMountPath(d.mountpoint, snap.name);

					const needIndex = !snap.indexed_at;
					const needDiff = prevSnap && prevSnapIsImmediate && !snap.diff_done;
					const canIncremental = needIndex && prevSnap && prevSnap.indexed_at;
					let diffDone = false;

					if (needIndex) {
						if (!snapPath) {
							prevSnap = snap;
							prevSnapIsImmediate = false;
							continue;
						}

						if (canIncremental && needDiff) {
							const { ms } = await processSnapshotWithTiming(db, stmt, perf, snap, prevSnap, dsId, 'incremental', () =>
								doIncrementalUnified(db, stmt, perf, prevSnap, snap, dsId, d.mountpoint, snapPath)
							);
							perf.incrMs += ms;
							perf.snapsIncremental++;
							perf.diffsDone++;
							diffDone = true;
						} else if (canIncremental) {
							const { ms } = await processSnapshotWithTiming(db, stmt, perf, snap, prevSnap, dsId, 'incremental', () =>
								doIncremental(db, stmt, perf, prevSnap, snap, dsId, d.mountpoint, snapPath)
							);
							perf.incrMs += ms;
							perf.snapsIncremental++;
						} else {
							const { ms, result: count } = await processSnapshotWithTiming(db, stmt, perf, snap, prevSnap, dsId, 'incremental', () =>
								doCrawl(db, stmt, perf, snap.id, dsId, snapPath, snap.full_name)
							);
							perf.filesCrawled += count;
							perf.crawlMs += ms;
							perf.snapsCrawled++;
						}

						// One transaction: a crash between the two flags would leave the
						// snapshot indexed but its diff pending (or the reverse), and the
						// next pass would re-derive it from the wrong branch.
						database.transaction(db, () => {
							if (diffDone) {
								stmt.markDiffDone.run(snap.id);
							}
							stmt.markIndexed.run(Math.floor(Date.now() / 1000), snap.id);
						});
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
					prevSnapIsImmediate = true;
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
					prevSnapIsImmediate = false;
				}
			}

			if (lastIncrSnapId !== null && lastIncrSnapId !== undefined) {
				const t = Date.now();
				stmt.bumpLastSeen.run(lastIncrSnapId, dsId);
				perf.sqlUpdates++;
				perf.sqlMs += Date.now() - t;
			}
		}

		if (pruneVanishedSnapshots(db, stmt, perf) > 0) {
			database.transaction(db, () => {
				for (const { dsId } of datasetWork) {
					stmt.repairLastSeenNull.run(dsId);
					stmt.repairFirstSeenNull.run(dsId);
				}
				stmt.deleteChangesForOrphanedFiles.run();
				stmt.deleteOrphanedFiles.run();
			});
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
	perf.crawlSkippedDirs += result.skippedDirs;

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
	// A previous run may have written changes for this snapshot and died before
	// marking it done; clear them so a replay can't double up.
	database.transaction(db, () => {
		stmt.deleteChangesBySnapshot.run(snap.id);
	});
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
	database.transaction(db, () => {
		stmt.deleteChangesBySnapshot.run(snap.id);
	});
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

// Exported for tests: these two carry the snapshot-retention invariants and are
// the only parts of a pass that can be exercised without a live ZFS pool.
export { run, pruneDeletedSnapshots, pruneVanishedSnapshots, forceBaselineRecrawl, prepareIndexerStatements, handleSnapshotError };
