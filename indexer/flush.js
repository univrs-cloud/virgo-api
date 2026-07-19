import * as database from './db.js';
import { STAT_CONCURRENCY, STAT_FAILURE_ABORT_RATIO, STAT_FAILURE_MIN_SAMPLE } from './constants.js';
import {
	safeStatAsync,
	makeSnapshotStatError,
	resolveRelPath,
	sizeFromStat,
	typeFromStat,
	modeStr,
} from './snapshot_util.js';

// ─── Stat helpers ────────────────────────────────────────────────────────────

/**
 * Stat each entry's `fullPath`. Returns an array of stat results (null on
 * failure) and a count of failures, so callers can decide whether to abort
 * the whole snapshot (wholesale stat failure usually means the ZFS snapshot
 * automount didn't take and EVERY path will fail).
 */
async function batchStat(entries, concurrency = STAT_CONCURRENCY) {
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

// ─── Path resolution + bulk lookups ──────────────────────────────────────────

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

// ─── Renames ─────────────────────────────────────────────────────────────────

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

// ─── Orphan sampling ─────────────────────────────────────────────────────────

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

export { flushIncrementalBatch, flushUnifiedBatch, flushChanges, reportSnapshotAnomalies };
