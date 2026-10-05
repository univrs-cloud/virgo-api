import * as database from './db.js';
import { snapshotMountPath } from './zfs.js';
import { STAT_CONCURRENCY } from './constants.js';
import { walkSnapshot } from './walker.js';
import {
	safeStatAsync,
	primeMountReadable,
	makeSnapshotStatError,
	isWholesaleStatFailure,
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
	if (isWholesaleStatFailure(statFailures, statTotal)) {
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
 *  - whatever sits at a path an added or renamed file is about to take
 */
function resolveBatchPaths(batch, mountpoint) {
	const relPaths = new Array(batch.length);
	const relNewPaths = new Array(batch.length);
	const lookup = new Set();
	for (let i = 0; i < batch.length; i++) {
		const c = batch[i];
		const relPath = resolveRelPath(c.path, mountpoint);
		relPaths[i] = relPath;
		lookup.add(relPath);
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

function bulkLoadFileMapAround(stmt, perf, datasetId, paths, prevSnap, snap) {
	if (!paths.size) {
		return new Map();
	}
	const t = Date.now();
	const rows = stmt.bulkLookupFilesAround.all(JSON.stringify([...paths]), datasetId, prevSnap.created_at, snap.created_at);
	perf.sqlSelects += rows.length;
	perf.sqlMs += Date.now() - t;
	const map = new Map();
	for (const r of rows) {
		map.set(r.path, {
			id: r.id,
			sizeBefore: r.size_before ?? null,
			sizeAtSnap: r.size_at_snap ?? null,
		});
	}
	return map;
}

// ─── Renames ─────────────────────────────────────────────────────────────────
//
// `zfs diff` lists a snapshot's events in no useful order, and names each path as
// it is in one of the two snapshots: the source of a rename and a removed file as
// they were in the previous one, everything else as it is in the new one. Applying
// events one by one moves rows about in between, so three rules keep every event
// attached to the object it is about:
//
//   - An old path is followed through every move made so far (`locateSource`),
//     never read from where the index has it now.
//   - When something new takes a path that still holds a file from before, that
//     file is neither overwritten nor reused. It is set aside (`displaceOccupants`)
//     until its own event arrives: a rename takes it to its new name, a removal
//     marks it deleted.
//   - A directory rename brings its files to paths where this snapshot may already
//     have recorded something. Whether that is the same file, seen early, or a new
//     one that replaced it is only known once the old file's own event has had its
//     chance, so the arriving file is set aside too.
//   - Whatever is still set aside when the snapshot is done was replaced, and is
//     settled then (`finishSnapshot`).

function createSnapshotContext() {
	return { moves: [], displaced: [], incoming: [] };
}

function isAt(path, root) {
	return path === root || path.startsWith(root + '/');
}

function likeEscape(s) {
	return s.replace(/[\\%_]/g, '\\$&');
}

/**
 * Bring the batch's prefetched `fileByPath` map back in line after rows moved.
 * The map is loaded once per batch, so every entry on either side of a move is
 * read again. Without this a later event in the same batch can be handed a row
 * that no longer sits at that path.
 */
function refreshMap(stmt, perf, datasetId, fileByPath, moves) {
	const paths = new Set();
	for (const key of [...fileByPath.keys()]) {
		for (const move of moves) {
			if (isAt(key, move.from)) {
				paths.add(key);
				paths.add(move.to + key.slice(move.from.length));
			} else if (isAt(key, move.to)) {
				paths.add(key);
			}
		}
	}
	for (const move of moves) {
		paths.add(move.from);
		paths.add(move.to);
	}
	for (const path of paths) {
		fileByPath.delete(path);
	}

	const rows = stmt.bulkLookupFiles.all(JSON.stringify([...paths]), datasetId);
	perf.sqlSelects += rows.length;
	for (const r of rows) {
		fileByPath.set(r.path, { id: r.id, latestSize: r.latest_size ?? null });
	}
}

/** The row an old path refers to, wherever the moves of this snapshot have put it. */
function locateSource(stmt, perf, datasetId, relPath, fileByPath, context) {
	let path = relPath;
	for (const move of context.moves) {
		if (isAt(path, move.from)) {
			path = move.to + path.slice(move.from.length);
		}
	}

	for (const { path: arrivedAt, hold } of context.incoming) {
		if (isAt(path, arrivedAt)) {
			const held = hold + path.slice(arrivedAt.length);
			const found = stmt.getFileByPath.get(datasetId, held) ?? null;
			perf.sqlSelects++;
			if (found) {
				return { path: held, row: { id: found.id, latestSize: null } };
			}
		}
	}

	let row = fileByPath.get(path) ?? null;
	if (!row && path !== relPath) {
		const found = stmt.getFileByPath.get(datasetId, path) ?? null;
		perf.sqlSelects++;
		row = (found ? { id: found.id, latestSize: null } : null);
	}
	return { path, row };
}

/** The directories this snapshot moved to somewhere at or under `path`. Their contents arrived with them. */
function arrivedUnder(context, path) {
	return JSON.stringify(context.moves.filter((move) => { return move.to !== path && isAt(move.to, path); }).map((move) => { return move.to; }));
}

/**
 * Set aside what was at `path` before this snapshot, with everything under it,
 * because something new is about to be there. What this snapshot itself put
 * there stays, and so do deleted rows, as history.
 */
function displaceOccupants(stmt, perf, datasetId, path, snapId, fileByPath, context) {
	const hold = `${path}#displaced@${snapId}.${context.displaced.length}`;
	const { changes } = stmt.moveOldRows.run(hold, path.length + 1, datasetId, path, snapId, arrivedUnder(context, path));
	perf.sqlUpdates++;
	if (Number(changes ?? 0) === 0) {
		return null;
	}

	const move = { from: path, to: hold };
	context.moves.push(move);
	context.displaced.push({ path, hold });
	refreshMap(stmt, perf, datasetId, fileByPath, [move]);
	return hold;
}

/**
 * `target` sits where `source` is about to be. What it recorded for this
 * snapshot was written under the new path by an event applied earlier, so it
 * belongs to the file arriving there and is handed over. What is left is an
 * earlier file of the same name: history that its snapshots still hold, parked
 * out of the way. A row with nothing left is dropped.
 */
function settleCollision(stmt, perf, targetId, sourceId, snapId) {
	stmt.moveVersionAtSnapshot.run(targetId, sourceId, snapId);
	stmt.deleteVersionAtSnapshot.run(targetId, snapId);
	stmt.moveChangesAtSnapshot.run(targetId, sourceId, snapId);
	if (stmt.hasVersions.get(targetId)) {
		stmt.parkFile.run(targetId, snapId);
		stmt.relastSeenIfAt.run(targetId, snapId);
	} else {
		stmt.deleteChangesOfFile.run(targetId);
		stmt.deleteFile.run(targetId);
	}
	perf.sqlUpdates++;
}

/**
 * An event applied before the rename may have written this snapshot's version of
 * the arriving file onto the row that was then at its path, which has since been
 * set aside. Give those records to the file that is there now.
 */
function reclaimFromHold(stmt, perf, datasetId, hold, path, snapId) {
	for (const r of stmt.heldRecords.all(snapId, path, hold.length + 1, datasetId, hold, `${hold}/`, `${hold}0`)) {
		stmt.moveVersionAtSnapshot.run(r.held_id, r.target_id, snapId);
		stmt.deleteVersionAtSnapshot.run(r.held_id, snapId);
		stmt.moveChangesAtSnapshot.run(r.held_id, r.target_id, snapId);
		perf.sqlUpdates++;
	}
}

/**
 * Rewrite every descendant path after a directory rename. `zfs diff` reports the
 * directory only — its children are untouched objects — so without this the whole
 * subtree keeps paths that no longer exist, and nothing ever corrects them.
 *
 * Only what was under the directory before this snapshot moves. A deleted file
 * keeps the path it had in the last snapshot that held it, which is where it is
 * recovered from, and what this snapshot put there belongs to whatever has that
 * name now.
 *
 * A file whose new path already holds a live row is not moved onto it. That row
 * was recorded by this snapshot, either for this same file or for a new one that
 * took its place, so the file waits aside for `finishSnapshot` to tell which.
 */
function renameSubtree(stmt, perf, datasetId, relOldPath, relNewPath, fileByPath, snapId, context) {
	const arrived = arrivedUnder(context, relOldPath);
	const hold = `${relNewPath}#incoming@${snapId}.${context.incoming.length}`;
	let isHolding = false;
	for (const collision of stmt.renameCollisions.all(datasetId, relNewPath, relOldPath.length + 1, relOldPath, snapId, arrived)) {
		if (collision.target_deleted_at !== null) {
			settleCollision(stmt, perf, collision.target_id, collision.source_id, snapId);
			continue;
		}
		stmt.setPath.run(collision.source_id, hold + collision.source_path.slice(relOldPath.length));
		perf.sqlUpdates++;
		isHolding = true;
	}
	if (isHolding) {
		context.incoming.push({ path: relNewPath, hold });
	}

	const { changes } = stmt.moveOldRows.run(relNewPath, relOldPath.length + 1, datasetId, relOldPath, snapId, arrived);
	perf.sqlUpdates++;
	perf.renamedSubtreePaths = (perf.renamedSubtreePaths ?? 0) + Number(changes ?? 0);

	const move = { from: relOldPath, to: relNewPath };
	context.moves.push(move);
	refreshMap(stmt, perf, datasetId, fileByPath, [move, { from: relNewPath, to: hold }]);
}

/**
 * Apply a ZFS rename to the files table, keeping the file's row and with it its
 * history. `sourcePath` and `oldFile` come from `locateSource`.
 *
 * @returns {{ fileId: number | null, oldSize: number | null }}
 */
function applyFileRename(stmt, perf, datasetId, sourcePath, relNewPath, st, snap, oldFile, fileByPath, context) {
	const type = typeFromStat(st);
	const hold = (sourcePath === relNewPath ? null : displaceOccupants(stmt, perf, datasetId, relNewPath, snap.id, fileByPath, context));

	// Children can be indexed even when the directory's own row is missing.
	const createAtNewPath = () => {
		const fileRow = stmt.upsertFile.get(datasetId, relNewPath, st.ino, type, snap.id, snap.id);
		perf.sqlUpserts++;
		if (type === 'dir') {
			renameSubtree(stmt, perf, datasetId, sourcePath, relNewPath, fileByPath, snap.id, context);
		}
		if (fileRow) {
			insertVersionFromStat(stmt, perf, fileRow.id, snap.id, st);
		}
		return { fileId: fileRow?.id ?? null, oldSize: null };
	};

	const move = () => {
		if (!oldFile) {
			return createAtNewPath();
		}

		const oldSize = oldFile.latestSize ?? stmt.sizeBeforeSnapshot.get(oldFile.id, snap.created_at)?.size ?? null;
		const leftover = stmt.getFileByPath.get(datasetId, relNewPath) ?? null;
		perf.sqlSelects++;
		if (leftover && leftover.id !== oldFile.id) {
			settleCollision(stmt, perf, leftover.id, oldFile.id, snap.id);
		}

		const renamed = stmt.updateFileRename.run(relNewPath, st.ino, type, snap.id, oldFile.id, datasetId);
		perf.sqlUpdates++;
		// Zero rows updated means the row is gone. Referencing its id now would trip
		// the foreign key and take the whole batch down, so build a fresh row instead.
		if (Number(renamed.changes ?? 0) === 0) {
			return createAtNewPath();
		}
		if (type === 'dir') {
			renameSubtree(stmt, perf, datasetId, sourcePath, relNewPath, fileByPath, snap.id, context);
		}
		insertVersionFromStat(stmt, perf, oldFile.id, snap.id, st);
		return { fileId: oldFile.id, oldSize };
	};

	const result = move();
	if (hold) {
		reclaimFromHold(stmt, perf, datasetId, hold, relNewPath, snap.id);
	}
	refreshMap(stmt, perf, datasetId, fileByPath, [{ from: sourcePath, to: relNewPath }]);
	return result;
}

/**
 * Settle what is still set aside once every event of the snapshot is in. Nothing
 * renamed these files and they are no longer where they were, so each was
 * replaced by whatever is at its path now:
 *
 *   - by an object this snapshot created there: the same file as far as its
 *     history goes, so the two rows become one that carries on;
 *   - by a file that was moved onto it: overwritten, kept as deleted history;
 *   - by nothing: removed.
 */
function finishSnapshot(db, stmt, perf, snap, datasetId, context) {
	const waiting = [...context.displaced, ...context.incoming];
	if (!waiting.length) {
		return;
	}

	database.transaction(db, () => {
		for (const { path, hold } of waiting) {
			for (const held of stmt.heldRows.all(datasetId, hold, `${hold}/`, `${hold}0`)) {
				const original = path + held.path.slice(hold.length);
				const occupant = stmt.getFileState.get(datasetId, original) ?? null;
				if (occupant && occupant.deleted_at_snap_id === null && occupant.first_seen_snap_id === snap.id) {
					stmt.moveAllVersions.run(occupant.id, held.id);
					stmt.deleteVersionsOfFile.run(occupant.id);
					stmt.moveAllChanges.run(occupant.id, held.id);
					stmt.deleteFile.run(occupant.id);
					stmt.reviveAt.run(held.id, original, occupant.inode, occupant.type, snap.id);
					const sizeBefore = stmt.sizeBeforeSnapshot.get(held.id, snap.created_at)?.size ?? null;
					if (sizeBefore !== null) {
						stmt.fillModifiedOldSize.run(held.id, snap.id, sizeBefore);
					}
					perf.recreatedPaths = (perf.recreatedPaths ?? 0) + 1;
					continue;
				}

				if (held.deleted_at_snap_id === null) {
					stmt.markDeleted.run(snap.id, held.id);
				}
				if (occupant) {
					stmt.parkAs.run(held.id, original, snap.id);
					perf.overwrittenFiles = (perf.overwrittenFiles ?? 0) + 1;
				} else {
					stmt.setPath.run(held.id, original);
				}
				perf.sqlUpdates++;
			}
		}
	});
}

/**
 * A removal was marked on a row that this snapshot's moves had already carried
 * somewhere else. The file never existed there, so the row goes back to the path
 * the removal named, the one its last snapshot holds, when that path is free.
 */
function restoreRemovedPaths(stmt, perf, datasetId, snapId, relPath, removedPath, fileRow, isSubtree, fileByPath) {
	if (fileRow) {
		stmt.restoreDeletedPath.run(relPath, fileRow.id);
		perf.sqlUpdates++;
	}
	if (isSubtree) {
		stmt.restoreDeletedSubtreePaths.run(relPath, removedPath.length + 1, datasetId, likeEscape(removedPath) + '/%', snapId);
		perf.sqlUpdates++;
	}
	fileByPath.delete(removedPath);
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

// ─── Directories that enter the indexed scope ───────────────────────────────

/**
 * A directory renamed in from outside the indexed scope reaches us as a single
 * `added` event: `zfs diff` reports the rename, not the files that came with it,
 * and until now none of them existed for the index. So its contents are crawled
 * from the snapshot, the way a baseline crawl would have found them.
 */
async function crawlEnteredDirs(db, stmt, perf, entered, snap, datasetId, snapPath, recordsChanges) {
	for (const dir of entered) {
		const result = await walkSnapshot(snapPath, (batch) => {
			const t = Date.now();
			database.transaction(db, () => {
				perf.sqlTxns++;
				for (const e of batch) {
					const fileRow = stmt.upsertFile.get(datasetId, e.path, e.inode, e.type, snap.id, snap.id);
					perf.sqlUpserts++;
					if (!fileRow) {
						continue;
					}
					stmt.insertVersion.run(fileRow.id, snap.id, e.size, e.mtime, e.ctime, e.nlink, e.mode);
					perf.sqlInserts++;
					if (recordsChanges) {
						stmt.insertChange.run(snap.id, fileRow.id, 'added', e.path, null, null, e.size, e.size, dir.changedAt);
						perf.sqlInserts++;
						perf.diffChanges++;
					}
				}
			});
			perf.sqlMs += Date.now() - t;
		}, dir.relPath);
		perf.statFailures += result.statFailures;
		perf.enteredDirFiles = (perf.enteredDirFiles ?? 0) + result.total;
	}
}

// ─── Batch flush: incremental only ─────────────────────────────────────────

async function flushIncrementalBatch(db, stmt, perf, batch, snap, datasetId, mountpoint, snapPath, context = createSnapshotContext()) {
	const { statMap, relPaths, relNewPaths, fileByPath } = await prepareIncrementalFlushContext(
		batch, snap, snapPath, mountpoint, perf, datasetId, stmt
	);

	const entered = [];
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
					if (fileByPath.has(relPath)) {
						displaceOccupants(stmt, perf, datasetId, relPath, snap.id, fileByPath, context);
					}
					const fileRow = stmt.upsertFile.get(datasetId, relPath, st.ino, type, snap.id, snap.id);
					perf.sqlUpserts++;
					if (fileRow) {
						const newSize = insertVersionFromStat(stmt, perf, fileRow.id, snap.id, st);
						fileByPath.set(relPath, { id: fileRow.id, latestSize: newSize });
					}
					if (c.isSubtree) {
						entered.push({ relPath, changedAt: c.changedAt ?? null });
					}
				}
			} else if (c.changeType === 'removed') {
				const { path: removedPath, row: fileRow } = locateSource(stmt, perf, datasetId, relPath, fileByPath, context);
				const moved = removedPath !== relPath;
				if (fileRow) { stmt.markDeleted.run(snap.id, fileRow.id); perf.sqlUpdates++; }
				if (c.isSubtree) { stmt.markSubtreeDeleted.run(snap.id, datasetId, likeEscape(removedPath) + '/%'); perf.sqlUpdates++; }
				if (moved) { restoreRemovedPaths(stmt, perf, datasetId, snap.id, relPath, removedPath, fileRow, c.isSubtree, fileByPath); }
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
					const { path: sourcePath, row: oldFile } = locateSource(stmt, perf, datasetId, relPath, fileByPath, context);
					applyFileRename(stmt, perf, datasetId, sourcePath, relNewPath, st, snap, oldFile, fileByPath, context);
				}
			}
		}
	});
	perf.sqlMs += Date.now() - t;
	await crawlEnteredDirs(db, stmt, perf, entered, snap, datasetId, snapPath, false);
}

// ─── Batch flush: unified incremental + diff ────────────────────────────────

async function flushUnifiedBatch(db, stmt, perf, batch, snap, datasetId, mountpoint, snapPath, context = createSnapshotContext()) {
	const { statMap, relPaths, relNewPaths, fileByPath } = await prepareIncrementalFlushContext(
		batch, snap, snapPath, mountpoint, perf, datasetId, stmt
	);

	const entered = [];
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
					if (fileByPath.has(relPath)) {
						displaceOccupants(stmt, perf, datasetId, relPath, snap.id, fileByPath, context);
					}
					const fileRow = stmt.upsertFile.get(datasetId, relPath, st.ino, type, snap.id, snap.id);
					perf.sqlUpserts++;
					if (fileRow) {
						fileId = fileRow.id;
						newSize = insertVersionFromStat(stmt, perf, fileRow.id, snap.id, st);
						fileByPath.set(relPath, { id: fileRow.id, latestSize: newSize });
					}
					if (c.isSubtree) {
						entered.push({ relPath, changedAt: c.changedAt ?? null });
					}
				}
			} else if (c.changeType === 'removed') {
				const { path: removedPath, row: fileRow } = locateSource(stmt, perf, datasetId, relPath, fileByPath, context);
				const moved = removedPath !== relPath;
				if (fileRow) {
					fileId = fileRow.id;
					// A replacement may already have recorded its own size on this
					// row, so the size of what was removed is read from before this
					// snapshot rather than from the row's latest.
					oldSize = stmt.sizeBeforeSnapshot.get(fileRow.id, snap.created_at)?.size ?? null;
					// A file that was replaced under the same name is marked deleted
					// like any other. `finishSnapshot` joins it with its replacement.
					stmt.markDeleted.run(snap.id, fileId);
					perf.sqlUpdates++;
				}
				if (c.isSubtree) {
					stmt.markSubtreeDeleted.run(snap.id, datasetId, likeEscape(removedPath) + '/%');
					perf.sqlUpdates++;
				}
				if (moved) {
					restoreRemovedPaths(stmt, perf, datasetId, snap.id, relPath, removedPath, fileRow, c.isSubtree, fileByPath);
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
					const { path: sourcePath, row: oldFile } = locateSource(stmt, perf, datasetId, relPath, fileByPath, context);
					const { fileId: rid, oldSize: rold } = applyFileRename(stmt, perf, datasetId, sourcePath, relNewPath, st, snap, oldFile, fileByPath, context);
					fileId = rid;
					oldSize = rold;
				}
			}

			if (fileId === null) {
				perf.orphanedChanges++;
				// `removed` events are never stat'ed (statBatch skips them), so a null
				// stat there means "not attempted", not "failed" — reporting it as a
				// stat failure sends you looking at the snapshot mount instead of at
				// the missing files row that actually caused the drop.
				const statFailed = c.changeType !== 'removed' && st === null;
				sampleOrphan(perf, snap, c.changeType, relPath, relNewPath, statFailed, 'unified');
				continue;
			}

			const delta = (newSize !== null || oldSize !== null) ? (newSize ?? 0) - (oldSize ?? 0) : null;
			stmt.insertChange.run(snap.id, fileId, c.changeType, relPath, relNewPath, oldSize, newSize, delta, c.changedAt ?? null);
			perf.sqlInserts++;
			perf.diffChanges++;
		}
	});
	perf.sqlMs += Date.now() - t;
	await crawlEnteredDirs(db, stmt, perf, entered, snap, datasetId, snapPath, true);
}

// ─── Diff for changes table (standalone, when both snaps already indexed) ──

const MAX_RENAME_HOPS = 32;

function findMovedFile(stmt, datasetId, relPath, snap) {
	let path = relPath;
	let after = snap.created_at;
	for (let hop = 0; hop < MAX_RENAME_HOPS; hop++) {
		const rename = stmt.nextRenameOfPath.get(datasetId, after, path);
		if (!rename) {
			break;
		}
		path = rename.new_path + path.slice(rename.old_path.length);
		after = rename.created_at;
	}
	if (path === relPath) {
		return null;
	}
	return stmt.getFileByPath.get(datasetId, path) ?? null;
}

async function statInSnapshot(snap, mountpoint, relPath, primed) {
	const snapPath = snapshotMountPath(mountpoint, snap.name);
	if (!primed.has(snap.id)) {
		if (!(await primeMountReadable(snapPath))) {
			throw makeSnapshotStatError(snap, snapPath, 1, 1);
		}
		primed.add(snap.id);
	}
	return safeStatAsync(snapPath + relPath);
}

async function firstSnapshotWithout(later, mountpoint, relPath, primed) {
	let low = 0;
	let high = later.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (await statInSnapshot(later[mid], mountpoint, relPath, primed)) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}

async function findDroppedFiles(stmt, perf, changes, relPaths, relNewPaths, fileByPath, prevSnap, snap, datasetId, mountpoint) {
	const dropped = [];
	const seen = new Set();
	const primed = new Set();
	let later = null;
	for (let i = 0; i < changes.length; i++) {
		if (changes[i].changeType === 'removed') {
			continue;
		}
		const path = relNewPaths[i] ?? relPaths[i];
		if (fileByPath.has(path) || seen.has(path)) {
			continue;
		}
		seen.add(path);

		const moved = findMovedFile(stmt, datasetId, path, snap);
		if (moved) {
			const sizes = stmt.fileSizesAround.get(moved.id, prevSnap.created_at, snap.created_at);
			fileByPath.set(path, { id: moved.id, sizeBefore: sizes?.size_before ?? null, sizeAtSnap: sizes?.size_at_snap ?? null });
			continue;
		}

		const st = await statInSnapshot(snap, mountpoint, path, primed);
		if (!st) {
			continue;
		}
		later ??= stmt.getSnapshotsForDataset.all(datasetId).filter(s => s.created_at > snap.created_at);
		const gone = await firstSnapshotWithout(later, mountpoint, path, primed);
		dropped.push({
			path,
			st,
			lastSeen: (gone > 0 ? later[gone - 1] : snap),
			deletedAt: later[gone] ?? null,
		});
	}
	perf.sqlSelects += seen.size;
	return dropped;
}

function restoreDroppedFiles(stmt, perf, dropped, fileByPath, snap, datasetId) {
	for (const d of dropped) {
		const fileRow = stmt.upsertFile.get(datasetId, d.path, d.st.ino, typeFromStat(d.st), snap.id, d.lastSeen.id);
		perf.sqlUpserts++;
		if (!fileRow) {
			continue;
		}
		const size = insertVersionFromStat(stmt, perf, fileRow.id, snap.id, d.st);
		if (d.deletedAt) {
			stmt.markDeleted.run(d.deletedAt.id, fileRow.id);
			perf.sqlUpdates++;
		}
		fileByPath.set(d.path, { id: fileRow.id, sizeBefore: null, sizeAtSnap: size });
		perf.backfilledFiles = (perf.backfilledFiles ?? 0) + 1;
	}
}

async function flushChanges(db, stmt, perf, changes, prevSnap, snap, datasetId, mountpoint) {
	const { relPaths, relNewPaths, lookup } = resolveBatchPaths(changes, mountpoint);
	const fileByPath = bulkLoadFileMapAround(stmt, perf, datasetId, lookup, prevSnap, snap);
	const dropped = await findDroppedFiles(stmt, perf, changes, relPaths, relNewPaths, fileByPath, prevSnap, snap, datasetId, mountpoint);

	const t = Date.now();
	database.transaction(db, () => {
		perf.sqlTxns++;
		restoreDroppedFiles(stmt, perf, dropped, fileByPath, snap, datasetId);
		for (let i = 0; i < changes.length; i++) {
			const c = changes[i];
			const relPath = relPaths[i];
			const relNewPath = relNewPaths[i];

			const fileRow = (c.changeType === 'renamed' ? fileByPath.get(relNewPath) : null) ?? fileByPath.get(relPath) ?? null;
			const fileId = fileRow?.id ?? null;

			let oldSize = null;
			let newSize = null;
			if (c.changeType === 'removed') {
				oldSize = fileRow?.sizeBefore ?? null;
			} else if (c.changeType === 'added') {
				newSize = fileRow?.sizeAtSnap ?? null;
			} else {
				oldSize = fileRow?.sizeBefore ?? null;
				newSize = fileRow?.sizeAtSnap ?? null;
			}

			if (fileId === null) {
				perf.orphanedChanges++;
				sampleOrphan(perf, snap, c.changeType, relPath, relNewPath, false, 'changes');
				continue;
			}

			if (c.changeType === 'removed') {
				stmt.markDeletedIfGone.run(snap.id, fileId, prevSnap.id);
				perf.sqlUpdates++;
				if (c.isSubtree) {
					stmt.markSubtreeDeleted.run(snap.id, datasetId, likeEscape(relPath) + '/%');
					perf.sqlUpdates++;
				}
			}

			const delta = (newSize !== null || oldSize !== null) ? (newSize ?? 0) - (oldSize ?? 0) : null;
			stmt.insertChange.run(snap.id, fileId, c.changeType, relPath, c.changeType === 'renamed' ? relNewPath : null, oldSize, newSize, delta, c.changedAt ?? null);
			perf.sqlInserts++;
			perf.diffChanges++;
		}
	});
	perf.sqlMs += Date.now() - t;
}

export { flushIncrementalBatch, flushUnifiedBatch, flushChanges, reportSnapshotAnomalies, createSnapshotContext, finishSnapshot };
