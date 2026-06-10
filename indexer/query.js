import * as database from './db.js';
import * as utils from './utils.js';
import { changeTypeBreakdown } from './index.js';

// ─── Dataset scope (opts.dataset / opts.datasets) ───────────────────────────
// Each root matches that ZFS dataset name or any child (messier/apps → messier/apps/foo).
// `dataset` may be comma-separated. `datasets` may be a string, comma-separated string, or array.

function parseDatasetScopes(opts = {}) {
	const chunks = [];
	if (opts.datasets !== null && opts.datasets !== undefined && opts.datasets !== '') {
		if (Array.isArray(opts.datasets)) {
			for (const x of opts.datasets) chunks.push(String(x));
		} else {
			chunks.push(String(opts.datasets));
		}
	}
	if (opts.dataset !== null && opts.dataset !== undefined && opts.dataset !== '') {
		chunks.push(String(opts.dataset));
	}
	const names = chunks
		.flatMap(s => s.split(','))
		.map(s => s.trim())
		.filter(Boolean);
	return [...new Set(names)];
}

function sqlDatasetScope(scopes, tableAlias = 'd') {
	if (!scopes?.length) {
		return { clause: '', params: [] };
	}
	const conds = [];
	const params = [];
	for (const root of scopes) {
		conds.push(`(${tableAlias}.name = ? OR ${tableAlias}.name LIKE ?)`);
		params.push(root, `${root}/%`);
	}
	return { clause: ` AND (${conds.join(' OR ')})`, params };
}

// ─── Search ─────────────────────────────────────────────────────────────────

function search(db, pattern, opts = {}) {
	if (!pattern) {
		console.log('Usage: virgo indexer search <term> [--dataset <names>] [--path <pattern>] [--type file|dir]');
		return null;
	}

	const scopes = parseDatasetScopes(opts);
	const { clause: DS_FILTER, params: dsScopeParams } = sqlDatasetScope(scopes, 'd');
	const pathFilterOpt = opts.path || null;
	const typeFilter = opts.type || null;
	const json = opts.json || false;
	const limit = opts.limit || 100;
	const offset = opts.offset || 0;
	const minSize = opts.minSize ?? null;
	const maxSize = opts.maxSize ?? null;
	const since = opts.since ? Math.floor(new Date(opts.since).getTime() / 1000) : null;
	const until = opts.until ? Math.floor(new Date(opts.until).getTime() / 1000) : null;

	const TYPE_FILTER = typeFilter ? `AND f.type = ?` : '';
	const baseParams = [...dsScopeParams, ...(typeFilter ? [typeFilter] : [])];

	let pathParam = null;
	if (pathFilterOpt) {
		pathParam = pathFilterOpt.replace(/\*/g, '%').replace(/\?/g, '_');
		if (!pathParam.includes('%') && !pathParam.includes('_')) {
			pathParam += '%';
		}
	}
	const PATH_FILTER = pathParam ? `AND f.path LIKE ?` : '';
	const pathParams = pathParam ? [pathParam] : [];

	const needVersionJoin = (minSize !== null && minSize !== undefined)
		|| (maxSize !== null && maxSize !== undefined)
		|| (since !== null && since !== undefined)
		|| (until !== null && until !== undefined);
	const VER_JOIN = needVersionJoin
		? `JOIN file_versions fv ON fv.file_id = f.id AND fv.snapshot_id = f.last_seen_snap_id`
		: '';
	const SIZE_MIN = (minSize !== null && minSize !== undefined) ? `AND fv.size >= ?` : '';
	const SIZE_MAX = (maxSize !== null && maxSize !== undefined) ? `AND fv.size <= ?` : '';
	const SINCE = (since !== null && since !== undefined) ? `AND fv.mtime >= ?` : '';
	const UNTIL = (until !== null && until !== undefined) ? `AND fv.mtime <= ?` : '';
	const filterParams = [minSize, maxSize, since, until].filter((v) => {
		return v !== null && v !== undefined;
	});

	let fileIds;
	if (pattern.includes('*') || pattern.includes('?')) {
		let glob = pattern.replace(/\*/g, '%').replace(/\?/g, '_');
		if (!glob.startsWith('%') && !glob.startsWith('/')) {
			glob = '%' + glob;
		}
		if (!glob.endsWith('%')) {
			glob = glob + '%';
		}
		fileIds = db.prepare(`
			SELECT DISTINCT f.id FROM files f
			JOIN datasets d ON d.id = f.dataset_id ${VER_JOIN}
			WHERE f.path LIKE ? ${DS_FILTER} ${TYPE_FILTER} ${SIZE_MIN} ${SIZE_MAX} ${SINCE} ${UNTIL} ${PATH_FILTER}
			LIMIT ? OFFSET ?
		`).all(glob, ...baseParams, ...filterParams, ...pathParams, limit, offset);
	} else {
		const ftsQuery = '"' + pattern.replace(/"/g, '""') + '"';
		try {
			fileIds = db.prepare(`
				SELECT DISTINCT f.id FROM fts_paths fp
				JOIN files f ON f.id = fp.rowid
				JOIN datasets d ON d.id = f.dataset_id ${VER_JOIN}
				WHERE fts_paths MATCH ? ${DS_FILTER} ${TYPE_FILTER} ${SIZE_MIN} ${SIZE_MAX} ${SINCE} ${UNTIL} ${PATH_FILTER}
				LIMIT ? OFFSET ?
			`).all(ftsQuery, ...baseParams, ...filterParams, ...pathParams, limit, offset);
		} catch {
			fileIds = [];
		}

		if (!fileIds.length && offset === 0) {
			fileIds = db.prepare(`
				SELECT DISTINCT f.id FROM files f
				JOIN datasets d ON d.id = f.dataset_id ${VER_JOIN}
				WHERE f.path LIKE ? ${DS_FILTER} ${TYPE_FILTER} ${SIZE_MIN} ${SIZE_MAX} ${SINCE} ${UNTIL} ${PATH_FILTER}
				LIMIT ? OFFSET ?
			`).all('%' + pattern + '%', ...baseParams, ...filterParams, ...pathParams, limit, offset);
		}
	}

	if (!fileIds.length) {
		console.log('No results.');
		return [];
	}

	const ids = fileIds.map(r => r.id);
	const placeholders = ids.map(() => '?').join(',');

	const rows = db.prepare(`
		SELECT
			f.id AS file_id,
			d.name AS dataset, d.mountpoint, f.path, f.type, fv.size, fv.mtime,
			strftime('%Y-%m-%dT%H:%M:%SZ', fv.mtime, 'unixepoch') AS modified,
			s.name AS snapshot,
			strftime('%Y-%m-%dT%H:%M:%SZ', s.created_at, 'unixepoch') AS snapshot_date,
			CASE WHEN f.deleted_at_snap_id IS NOT NULL THEN 1 ELSE 0 END AS deleted,
			c.change_type
		FROM file_versions fv
		JOIN files f ON f.id = fv.file_id
		JOIN datasets d ON d.id = f.dataset_id
		JOIN snapshots s ON s.id = fv.snapshot_id
		LEFT JOIN changes c ON c.file_id = f.id AND c.snapshot_id = fv.snapshot_id
		WHERE f.id IN (${placeholders})
		GROUP BY fv.id
		ORDER BY d.name, f.path, s.created_at
	`).all(...ids);

	const grouped = new Map();
	for (const r of rows) {
		if (!grouped.has(r.file_id)) {
			grouped.set(r.file_id, []);
		}
		grouped.get(r.file_id).push(r);
	}

	const results = [];
	for (const versions of grouped.values()) {
		const latest = versions[versions.length - 1];
		const versionList = versions.map(v => ({
			snapshot: v.snapshot,
			snapshot_on: v.snapshot_date,
			change: v.change_type ?? null,
			size: v.size,
			modified_on: v.modified,
			snapshot_path: v.mountpoint ? `${v.mountpoint}/.zfs/snapshot/${v.snapshot}${v.path}` : null,
		}));

		const showVersions = versionList.length > 1 || latest.deleted;

		const entry = {
			dataset: latest.dataset,
			mountpoint: latest.mountpoint,
			path: latest.path,
			live_path: latest.deleted ? null : (latest.mountpoint ? latest.mountpoint + latest.path : null),
			type: latest.type,
			size: latest.size,
			modified_on: latest.modified,
			deleted: latest.deleted,
		};

		if (showVersions) {
			entry.versions = versionList;
		}

		results.push(entry);
	}

	if (!json) {
		for (const r of results) {
			const del = r.deleted ? ' [DELETED]' : '';
			console.log(`${r.dataset} ${r.path}${del}`);
			console.log(`${r.type} ${utils.formatSize(r.size)} modified ${r.modified_on}`);

			if (r.deleted) {
				const recoverPath = r.versions?.[r.versions.length - 1]?.snapshot_path;
				if (recoverPath) {
					console.log(`recover from: ${recoverPath}`);
				}
			} else {
				if (r.live_path) {
					console.log(`path: ${r.live_path}`);
				}
			}

			if (r.versions && r.versions.length > 1) {
				console.log(`history (${r.versions.length} versions):`);
				for (const v of r.versions) {
					const ch = v.change ? ` [${v.change}]` : '';
					console.log(`[${v.snapshot_on}] ${utils.formatSize(v.size)}${ch} ${v.snapshot}`);
				}
			}
			console.log('');
		}
	}

	return results;
}

// ─── History ────────────────────────────────────────────────────────────────

function history(db, path, opts = {}) {
	if (!path) {
		console.log('Usage: virgo indexer history <path> [--dataset <names>]');
		return null;
	}

	const json = opts.json || false;
	const scopes = parseDatasetScopes(opts);
	const { clause: DS_FILTER, params: dsParams } = sqlDatasetScope(scopes, 'd');

	const versions = db.prepare(`
		SELECT
			d.name AS dataset,
			d.mountpoint,
			s.name AS snapshot,
			s.full_name,
			strftime('%Y-%m-%dT%H:%M:%SZ', s.created_at, 'unixepoch') AS snapshot_date,
			f.path,
			fv.size,
			strftime('%Y-%m-%dT%H:%M:%SZ', fv.mtime, 'unixepoch') AS modified,
			fv.mode
		FROM file_versions fv
		JOIN files f ON f.id = fv.file_id
		JOIN datasets d ON d.id = f.dataset_id
		JOIN snapshots s ON s.id = fv.snapshot_id
		WHERE f.path = ?${DS_FILTER}
		ORDER BY d.name, s.created_at
	`).all(path, ...dsParams);

	const chScope = sqlDatasetScope(scopes, 'd');
	const chgs = db.prepare(`
		SELECT
			s.name AS snapshot,
			strftime('%Y-%m-%dT%H:%M:%SZ', s.created_at, 'unixepoch') AS snapshot_date,
			c.change_type,
			c.old_path,
			c.new_path,
			c.old_size,
			c.new_size,
			c.delta_bytes
		FROM changes c
		JOIN snapshots s ON s.id = c.snapshot_id
		JOIN datasets d ON d.id = s.dataset_id
		WHERE (c.old_path = ? OR c.new_path = ?)${chScope.clause}
		ORDER BY s.created_at
	`).all(path, path, ...chScope.params);

	if (!versions.length && !chgs.length) {
		console.log('No history found for that path.');
		return { path, versions: [], changes: [] };
	}

	for (const v of versions) {
		v.snapshot_path = v.mountpoint ? `${v.mountpoint}/.zfs/snapshot/${v.snapshot}${v.path}` : null;
	}

	if (!json) {
		console.log(`\n📄 History for: ${path}\n`);

		if (versions.length) {
			console.log('Versions:');
			for (const v of versions) {
				console.log(`  [${v.snapshot_date}] ${v.dataset}@${v.snapshot}`);
				console.log(`    Size: ${utils.formatSize(v.size)}  Mode: ${v.mode}  Modified: ${v.modified}`);
				if (v.snapshot_path) {
					console.log(`    path: ${v.snapshot_path}`);
				}
			}
		}

		if (chgs.length) {
			console.log('\nChange events:');
			for (const c of chgs) {
				const delta = c.delta_bytes > 0 ? `+${utils.formatSize(c.delta_bytes)}` : utils.formatSize(c.delta_bytes);
				if (c.change_type === 'renamed') {
					console.log(`  [${c.snapshot_date}] RENAMED ${c.old_path} → ${c.new_path}`);
				} else {
					const szOld = (c.old_size !== null && c.old_size !== undefined) ? utils.formatSize(c.old_size) : '?';
					const szNew = (c.new_size !== null && c.new_size !== undefined) ? utils.formatSize(c.new_size) : '?';
					console.log(`  [${c.snapshot_date}] ${c.change_type.toUpperCase()} ${szOld} → ${szNew} (${delta})`);
				}
			}
		}
		console.log('');
	}

	return { path, versions, changes: chgs };
}

// ─── Deleted ────────────────────────────────────────────────────────────────

function deleted(db, opts = {}) {
	const scopes = parseDatasetScopes(opts);
	const { clause: DS_FILTER, params: dsParams } = sqlDatasetScope(scopes, 'd');
	const pathFilter = opts.path || null;
	const json = opts.json || false;
	const limit = opts.limit || 2000;
	const offset = opts.offset || 0;

	let pathParam = null;
	if (pathFilter) {
		pathParam = pathFilter.replace(/\*/g, '%').replace(/\?/g, '_');
		if (!pathParam.includes('%') && !pathParam.includes('_')) {
			pathParam += '%';
		}
	}

	const rows = db.prepare(`
		SELECT
			d.name AS dataset,
			d.mountpoint,
			f.path AS last_path,
			f.type,
			fv.size,
			s_last.name AS last_seen_snap,
			strftime('%Y-%m-%dT%H:%M:%SZ', s_last.created_at, 'unixepoch') AS last_seen,
			strftime('%Y-%m-%dT%H:%M:%SZ', s_del.created_at, 'unixepoch') AS deleted_in,
			s_del.name AS deleted_snapshot
		FROM files f
		JOIN datasets d ON d.id = f.dataset_id
		JOIN snapshots s_last ON s_last.id = f.last_seen_snap_id
		JOIN snapshots s_del ON s_del.id = f.deleted_at_snap_id
		JOIN file_versions fv ON fv.file_id = f.id
			AND fv.id = (SELECT id FROM file_versions WHERE file_id = f.id ORDER BY snapshot_id DESC LIMIT 1)
		WHERE f.deleted_at_snap_id IS NOT NULL${DS_FILTER}
			${pathParam ? 'AND f.path LIKE ?' : ''}
		ORDER BY s_del.created_at DESC, f.path
		LIMIT ? OFFSET ?
	`).all(
		...dsParams,
		...(pathParam ? [pathParam] : []),
		limit, offset
	);

	if (!rows.length) {
		console.log('No deleted files found.');
		return { deleted: [] };
	}

	for (const r of rows) {
		r.snapshot_path = r.mountpoint ? `${r.mountpoint}/.zfs/snapshot/${r.last_seen_snap}${r.last_path}` : null;
	}

	if (!json) {
		console.log(`\n🗑  Deleted files (${rows.length}):\n`);
		for (const r of rows) {
			console.log(`${r.dataset} ${r.last_path} [${r.type}]`);
			console.log(`Size: ${utils.formatSize(r.size)} Last seen: ${r.last_seen} Deleted: ${r.deleted_in} (${r.deleted_snapshot})`);
			if (r.snapshot_path) {
				console.log(`  recover from: ${r.snapshot_path}`);
			}
			console.log('');
		}
	}

	return { deleted: rows };
}

// ─── Changes ────────────────────────────────────────────────────────────────

function changes(db, snapshotName, opts = {}) {
	if (!snapshotName) {
		console.log('Usage: virgo indexer changes <snapshot> [--dataset <names>] [--path <pattern>]');
		return null;
	}

	const json = opts.json || false;
	const scopes = parseDatasetScopes(opts);
	const pathFilterOpt = opts.path || null;
	const limit = opts.limit || 5000;
	const offset = opts.offset || 0;

	let pathParam = null;
	if (pathFilterOpt) {
		pathParam = pathFilterOpt.replace(/\*/g, '%').replace(/\?/g, '_');
		if (!pathParam.includes('%') && !pathParam.includes('_')) {
			pathParam += '%';
		}
	}
	const PATH_FILTER = pathParam
		? `AND ((c.old_path LIKE ?) OR (c.new_path LIKE ?))`
		: '';
	const pathParams = pathParam ? [pathParam, pathParam] : [];

	let snap;
	if (scopes.length) {
		const { clause, params } = sqlDatasetScope(scopes, 'd');
		snap = db.prepare(`
			SELECT s.id, s.full_name, s.created_at
			FROM snapshots s
			JOIN datasets d ON d.id = s.dataset_id
			WHERE (s.name=? OR s.full_name=?)${clause}
			LIMIT 1
		`).get(snapshotName, snapshotName, ...params);
	} else {
		snap = db.prepare(
			`SELECT id, full_name, created_at FROM snapshots WHERE full_name=? LIMIT 1`
		).get(snapshotName);
		if (!snap) {
			snap = db.prepare(
				`SELECT id, full_name, created_at FROM snapshots WHERE name=? LIMIT 1`
			).get(snapshotName);
		}
	}

	if (!snap) {
		console.log(`Snapshot '${snapshotName}' not found.`);
		return null;
	}

	const rows = db.prepare(`
		SELECT c.change_type, c.old_path, c.new_path, c.old_size, c.new_size, c.delta_bytes
		FROM changes c
		WHERE c.snapshot_id = ? ${PATH_FILTER}
		ORDER BY c.change_type, c.new_path, c.old_path
		LIMIT ? OFFSET ?
	`).all(snap.id, ...pathParams, limit, offset);

	const result = {
		snapshot: snap.full_name,
		created_at: new Date(snap.created_at * 1000).toISOString(),
		total: rows.length,
		changes: rows,
	};

	if (!rows.length) {
		console.log('No changes recorded for this snapshot.');
		return result;
	}

	if (!json) {
		console.log(`\n↔️  Changes in ${snap.full_name} (${result.created_at}):`);
		console.log(`   Total: ${rows.length}\n`);

		const byType = {};
		for (const r of rows) {
			(byType[r.change_type] ??= []).push(r);
		}

		for (const [type, items] of Object.entries(byType)) {
			console.log(`  ${type.toUpperCase()} (${items.length}):`);
			for (const r of items.slice(0, 50)) {
				if (type === 'renamed') {
					console.log(`    ${r.old_path} → ${r.new_path}`);
				} else {
					const delta = (r.delta_bytes !== null && r.delta_bytes !== undefined)
						? ` (${r.delta_bytes >= 0 ? '+' : ''}${utils.formatSize(r.delta_bytes)})`
						: '';
					console.log(`    ${r.old_path ?? r.new_path}${delta}`);
				}
			}
			if (items.length > 50) {
				console.log(`    ... and ${items.length - 50} more`);
			}
			console.log('');
		}
	}

	return result;
}

// ─── Diff ───────────────────────────────────────────────────────────────────

function diff(db, snapA, snapB, opts = {}) {
	if (!snapA || !snapB) {
		console.log('Usage: virgo indexer diff <snap_a> <snap_b>');
		return null;
	}

	const json = opts.json || false;
	const limit = opts.limit || 5000;
	const offset = opts.offset || 0;

	const sA = db.prepare(`SELECT id FROM snapshots WHERE full_name=? OR name=? LIMIT 1`).get(snapA, snapA);
	const sB = db.prepare(`SELECT id FROM snapshots WHERE full_name=? OR name=? LIMIT 1`).get(snapB, snapB);
	if (!sA) {
		console.log(`Snapshot '${snapA}' not found.`);
		return null;
	}
	if (!sB) {
		console.log(`Snapshot '${snapB}' not found.`);
		return null;
	}
	const idA = sA.id;
	const idB = sB.id;

	const rows = db.prepare(`
		SELECT path, size_a, size_b, delta, status FROM (
			-- Files present in both snapshots (modified or unchanged)
			SELECT
				f.path,
				fv_a.size AS size_a,
				fv_b.size AS size_b,
				(fv_b.size - fv_a.size) AS delta,
				CASE
					WHEN fv_b.mtime != fv_a.mtime THEN 'modified'
					ELSE 'unchanged'
				END AS status
			FROM file_versions fv_b
			JOIN file_versions fv_a ON fv_a.file_id = fv_b.file_id AND fv_a.snapshot_id = ?
			JOIN files f ON f.id = fv_b.file_id
			WHERE fv_b.snapshot_id = ?

			UNION ALL

			-- Files only in snapshot B (added)
			SELECT
				f.path,
				NULL AS size_a,
				fv_b.size AS size_b,
				fv_b.size AS delta,
				'added' AS status
			FROM file_versions fv_b
			JOIN files f ON f.id = fv_b.file_id
			WHERE fv_b.snapshot_id = ?
				AND NOT EXISTS (
					SELECT 1 FROM file_versions fv_a
					WHERE fv_a.file_id = fv_b.file_id AND fv_a.snapshot_id = ?
				)

			UNION ALL

			-- Files only in snapshot A (removed)
			SELECT
				f.path,
				fv_a.size AS size_a,
				NULL AS size_b,
				-fv_a.size AS delta,
				'removed' AS status
			FROM file_versions fv_a
			JOIN files f ON f.id = fv_a.file_id
			WHERE fv_a.snapshot_id = ?
				AND NOT EXISTS (
					SELECT 1 FROM file_versions fv_b
					WHERE fv_b.file_id = fv_a.file_id AND fv_b.snapshot_id = ?
				)
		)
		WHERE status != 'unchanged'
		ORDER BY status, path
		LIMIT ? OFFSET ?
	`).all(idA, idB, idB, idA, idA, idB, limit, offset);

	const result = { from: snapA, to: snapB, total: rows.length, files: rows };

	if (!json) {
		console.log(`\n Diff ${snapA} → ${snapB}: ${rows.length} changed files\n`);
		for (const r of rows) {
			const delta = r.delta >= 0 ? `+${utils.formatSize(r.delta)}` : utils.formatSize(r.delta);
			console.log(`  [${r.status.toUpperCase().padEnd(8)}] ${r.path}  (${delta})`);
		}
	}

	return result;
}

// ─── Reindex ────────────────────────────────────────────────────────────────

function reindex(db, opts = {}) {
	const scopes = parseDatasetScopes(opts);

	if (scopes.length) {
		const seen = new Set();
		const ids = [];
		for (const root of scopes) {
			const rows = db.prepare('SELECT id FROM datasets WHERE name = ? OR name LIKE ?').all(root, `${root}/%`);
			for (const { id } of rows) {
				if (!seen.has(id)) {
					seen.add(id);
					ids.push(id);
				}
			}
		}
		if (!ids.length) {
			console.log(`No datasets matched: ${scopes.join(', ')}`);
			return;
		}

		database.transaction(db, () => {
			for (const id of ids) {
				db.prepare('DELETE FROM changes WHERE snapshot_id IN (SELECT id FROM snapshots WHERE dataset_id = ?)').run(id);
				db.prepare('DELETE FROM file_versions WHERE file_id IN (SELECT id FROM files WHERE dataset_id = ?)').run(id);
				db.prepare('DELETE FROM files WHERE dataset_id = ?').run(id);
				db.prepare('UPDATE snapshots SET indexed_at = NULL, diff_done = 0 WHERE dataset_id = ?').run(id);
			}
		});

		console.log(`Reset indexing state for ${ids.length} dataset(s). Run 'virgo indexer index' to rebuild.`);
	} else {
		database.transaction(db, () => {
			db.exec('DELETE FROM changes');
			db.exec('DELETE FROM file_versions');
			db.exec('DELETE FROM files');
			db.exec('UPDATE snapshots SET indexed_at = NULL, diff_done = 0');
		});

		console.log("Reset all indexing state. Run 'virgo indexer index' to rebuild.");
	}
}

// ─── Stats ──────────────────────────────────────────────────────────────────

function stats(db, opts = {}) {
	const json = opts.json || false;

	const statsRow = db.prepare(`
		SELECT
			(SELECT COUNT(*) FROM datasets)      AS datasets,
			(SELECT COUNT(*) FROM snapshots)     AS snapshots,
			(SELECT COUNT(*) FROM snapshots WHERE indexed_at IS NOT NULL) AS indexed,
			(SELECT COUNT(*) FROM files)         AS files,
			(SELECT COUNT(*) FROM file_versions) AS versions,
			(SELECT COUNT(*) FROM changes)       AS changes,
			(SELECT COUNT(*) FROM files WHERE deleted_at_snap_id IS NOT NULL) AS deleted,
			(SELECT value FROM meta WHERE key = 'last_run_at') AS last_run_at,
			(SELECT value FROM meta WHERE key = 'last_activity_at') AS last_activity_at,
			(SELECT value FROM meta WHERE key = 'last_run_orphan_changes') AS last_run_orphan_changes,
			(SELECT value FROM meta WHERE key = 'last_run_stat_failures') AS last_run_stat_failures,
			(SELECT value FROM meta WHERE key = 'last_run_restart_count') AS last_run_restart_count,
			(SELECT value FROM meta WHERE key = 'last_run_failed_snapshots') AS last_run_failed_snapshots,
			(SELECT value FROM meta WHERE key = 'last_run_orphan_samples') AS last_run_orphan_samples,
			(SELECT value FROM meta WHERE key = 'last_run_backfilled_files') AS last_run_backfilled_files,
			(SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()) AS db_bytes
	`).get();

	const topDatasets = db.prepare(`
		SELECT d.name,
			(SELECT COUNT(*) FROM files f WHERE f.dataset_id = d.id) AS file_count,
			(SELECT COUNT(*) FROM snapshots s WHERE s.dataset_id = d.id) AS snap_count
		FROM datasets d
		ORDER BY file_count DESC
		LIMIT 10
	`).all();

	const changeTypes = changeTypeBreakdown(db);

	const lastRun = {
		orphan_changes:   Number(statsRow.last_run_orphan_changes   ?? 0),
		stat_failures:    Number(statsRow.last_run_stat_failures    ?? 0),
		restart_count:    Number(statsRow.last_run_restart_count    ?? 0),
		backfilled_files: Number(statsRow.last_run_backfilled_files ?? 0),
		failed_snapshots: parseFailedSnapshots(statsRow.last_run_failed_snapshots),
		orphan_samples:   parseJsonArray(statsRow.last_run_orphan_samples),
	};

	const result = {
		...statsRow,
		change_types: changeTypes,
		last_run: lastRun,
		top_datasets: topDatasets,
	};
	// Don't leak the raw JSON strings — only the parsed `last_run` object.
	delete result.last_run_orphan_changes;
	delete result.last_run_stat_failures;
	delete result.last_run_restart_count;
	delete result.last_run_failed_snapshots;
	delete result.last_run_orphan_samples;
	delete result.last_run_backfilled_files;

	if (!json) {
		console.log('\n📊 ZFS Index Statistics\n');
		console.log(`Last run (completed): ${statsRow.last_run_at ?? 'null'}`);
		console.log(`Last activity: ${statsRow.last_activity_at ?? 'null'}`);
		console.log(`DB size: ${utils.formatSize(statsRow.db_bytes)}`);
		console.log(`Datasets: ${statsRow.datasets}`);
		console.log(`Snapshots: ${statsRow.snapshots} (${statsRow.indexed} indexed)`);
		console.log(`Unique files: ${statsRow.files.toLocaleString()}`);
		console.log(`File versions: ${statsRow.versions.toLocaleString()}`);
		console.log(`Change events: ${statsRow.changes.toLocaleString()}`);
		console.log(`  added:    ${changeTypes.added.toLocaleString()}`);
		console.log(`  modified: ${changeTypes.modified.toLocaleString()}`);
		console.log(`  renamed:  ${changeTypes.renamed.toLocaleString()}`);
		console.log(`  removed:  ${changeTypes.removed.toLocaleString()}`);
		if (changeTypes.unknown > 0) {
			console.log(`  unknown:  ${changeTypes.unknown.toLocaleString()}`);
		}
		console.log(`Deleted files: ${statsRow.deleted.toLocaleString()}`);

		if (lastRun.backfilled_files > 0) {
			console.log(`\n♻  Last run self-repair: ${lastRun.backfilled_files.toLocaleString()} file row(s) backfilled`);
		}

		const anyFailures = lastRun.orphan_changes > 0 || lastRun.stat_failures > 0 || lastRun.failed_snapshots.length > 0 || lastRun.restart_count > 0;
		if (anyFailures) {
			console.log('\n⚠  Last run failures:');
			console.log(`  Orphan changes skipped: ${lastRun.orphan_changes.toLocaleString()}`);
			console.log(`  Stat failures:          ${lastRun.stat_failures.toLocaleString()}`);
			console.log(`  Restarts:               ${lastRun.restart_count}`);
			console.log(`  Failed snapshots:       ${lastRun.failed_snapshots.length}`);
			for (const f of lastRun.failed_snapshots.slice(0, 5)) {
				console.log(`    • ${f.name} (${f.reason})`);
			}
			if (lastRun.failed_snapshots.length > 5) {
				console.log(`    …and ${lastRun.failed_snapshots.length - 5} more`);
			}
			if (lastRun.orphan_samples.length > 0) {
				console.log('  Orphan samples:');
				for (const s of lastRun.orphan_samples.slice(0, 10)) {
					const snap = s.snapshot ? ` @${s.snapshot}` : '';
					console.log(`    · [${s.type}/${s.cause}]${snap} ${s.path}`);
				}
				if (lastRun.orphan_changes > lastRun.orphan_samples.length) {
					console.log(`    …and ${(lastRun.orphan_changes - lastRun.orphan_samples.length).toLocaleString()} more (not sampled)`);
				}
			}
		}

		console.log('\nTop datasets by file count:');
		for (const d of topDatasets) {
			console.log(`     ${d.name.padEnd(30)} ${d.file_count.toLocaleString()} files / ${d.snap_count} snapshots`);
		}
	}

	return result;
}

function parseFailedSnapshots(raw) {
	return parseJsonArray(raw);
}

function parseJsonArray(raw) {
	if (!raw) {
		return [];
	}
	try {
		const v = JSON.parse(raw);
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}

export {
	search,
	history,
	deleted,
	changes,
	diff,
	reindex,
	stats,
	parseDatasetScopes,
};
