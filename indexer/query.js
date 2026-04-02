'use strict';

const { openDb, transaction } = require('./db');
const { getConfig } = require('./config');
const { formatSize } = require('./utils');

// ─── Open DB helper for bin entry point ─────────────────────────────────────

function open(dbPath) {
  const config = getConfig({ db: dbPath });
  return openDb(config.DB_PATH);
}

// ─── Search ─────────────────────────────────────────────────────────────────

function search(db, pattern, opts = {}) {
  if (!pattern) {
    console.log('Usage: virgo search <term> [--dataset <n>] [--path <pattern>] [--type file|dir]');
    return null;
  }

  const datasetFilter = opts.dataset || null;
  const pathFilterOpt = opts.path    || null;
  const typeFilter    = opts.type    || null;
  const json          = opts.json    || false;
  const limit         = opts.limit   || 100;
  const offset        = opts.offset  || 0;
  const minSize       = opts.minSize ?? null;
  const maxSize       = opts.maxSize ?? null;
  const since         = opts.since ? Math.floor(new Date(opts.since).getTime() / 1000) : null;
  const until         = opts.until ? Math.floor(new Date(opts.until).getTime() / 1000) : null;

  const DS_FILTER   = datasetFilter ? `AND d.name = ?` : '';
  const TYPE_FILTER = typeFilter    ? `AND f.type = ?`    : '';
  const baseParams  = [datasetFilter, typeFilter].filter(Boolean);

  let pathParam = null;
  if (pathFilterOpt) {
    pathParam = pathFilterOpt.replace(/\*/g, '%').replace(/\?/g, '_');
    if (!pathParam.includes('%') && !pathParam.includes('_')) {
      pathParam += '%';
    }
  }
  const PATH_FILTER = pathParam ? `AND f.path LIKE ?` : '';
  const pathParams  = pathParam ? [pathParam] : [];

  const needVersionJoin = minSize != null || maxSize != null || since != null || until != null;
  const VER_JOIN = needVersionJoin
    ? `JOIN file_versions fv ON fv.file_id = f.id AND fv.snapshot_id = f.last_seen_snap_id`
    : '';
  const SIZE_MIN = minSize != null ? `AND fv.size >= ?` : '';
  const SIZE_MAX = maxSize != null ? `AND fv.size <= ?` : '';
  const SINCE    = since   != null ? `AND fv.mtime >= ?` : '';
  const UNTIL    = until   != null ? `AND fv.mtime <= ?` : '';
  const filterParams = [minSize, maxSize, since, until].filter(v => v != null);

  let fileIds;
  if (pattern.includes('*') || pattern.includes('?')) {
    let glob = pattern.replace(/\*/g, '%').replace(/\?/g, '_');
    if (!glob.startsWith('%') && !glob.startsWith('/')) glob = '%' + glob;
    if (!glob.endsWith('%')) glob = glob + '%';
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
    } catch { fileIds = []; }

    if (!fileIds.length && offset === 0) {
      fileIds = db.prepare(`
        SELECT DISTINCT f.id FROM files f
        JOIN datasets d ON d.id = f.dataset_id ${VER_JOIN}
        WHERE f.path LIKE ? ${DS_FILTER} ${TYPE_FILTER} ${SIZE_MIN} ${SIZE_MAX} ${SINCE} ${UNTIL} ${PATH_FILTER}
        LIMIT ? OFFSET ?
      `).all('%' + pattern + '%', ...baseParams, ...filterParams, ...pathParams, limit, offset);
    }
  }

  if (!fileIds.length) { console.log('No results.'); return []; }

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
    JOIN files     f ON f.id = fv.file_id
    JOIN datasets  d ON d.id = f.dataset_id
    JOIN snapshots s ON s.id = fv.snapshot_id
    LEFT JOIN changes c ON c.file_id = f.id AND c.snapshot_id = fv.snapshot_id
    WHERE f.id IN (${placeholders})
    GROUP BY fv.id
    ORDER BY d.name, f.path, s.created_at
  `).all(...ids);

  const grouped = new Map();
  for (const r of rows) {
    if (!grouped.has(r.file_id)) grouped.set(r.file_id, []);
    grouped.get(r.file_id).push(r);
  }

  const results = [];
  for (const versions of grouped.values()) {
    const latest = versions[versions.length - 1];
    const versionList = versions.map(v => ({
      snapshot:      v.snapshot,
      snapshot_on:   v.snapshot_date,
      change:        v.change_type ?? null,
      size:          v.size,
      modified_on:   v.modified,
      snapshot_path: v.mountpoint ? `${v.mountpoint}/.zfs/snapshot/${v.snapshot}${v.path}` : null,
    }));

    const showVersions = versionList.length > 1 || latest.deleted;

    const entry = {
      dataset:      latest.dataset,
      mountpoint:   latest.mountpoint,
      path:         latest.path,
      live_path:    latest.deleted ? null : (latest.mountpoint ? latest.mountpoint + latest.path : null),
      type:         latest.type,
      size:         latest.size,
      modified_on:  latest.modified,
      deleted:      latest.deleted,
    };

    if (showVersions) entry.versions = versionList;

    results.push(entry);
  }

  if (!json) {
    for (const r of results) {
      const del = r.deleted ? ' [DELETED]' : '';
      console.log(`${r.dataset}  ${r.path}${del}`);
      console.log(`  ${r.type}  ${formatSize(r.size)}  modified ${r.modified_on}`);

      if (r.deleted) {
        const recoverPath = r.versions?.[r.versions.length - 1]?.snapshot_path;
        if (recoverPath) console.log(`  recover from: ${recoverPath}`);
      } else {
        if (r.live_path) console.log(`  path: ${r.live_path}`);
      }

      if (r.versions && r.versions.length > 1) {
        console.log(`  history (${r.versions.length} versions):`);
        for (const v of r.versions) {
          const ch = v.change ? ` [${v.change}]` : '';
          console.log(`    [${v.snapshot_on}] ${formatSize(v.size)}${ch}  ${v.snapshot}`);
        }
      }
      console.log('');
    }
  }

  return results;
}

// ─── History ────────────────────────────────────────────────────────────────

function history(db, path, opts = {}) {
  if (!path) { console.log('Usage: virgo history <path> [--dataset <name>]'); return null; }

  const json        = opts.json    || false;
  const datasetName = opts.dataset || null;

  const DS_FILTER = datasetName ? `AND d.name = ?` : '';
  const dsParams  = datasetName ? [datasetName] : [];

  const versions = db.prepare(`
    SELECT
      d.name       AS dataset,
      d.mountpoint,
      s.name       AS snapshot,
      s.full_name,
      strftime('%Y-%m-%dT%H:%M:%SZ', s.created_at, 'unixepoch') AS snapshot_date,
      f.path,
      fv.size,
      strftime('%Y-%m-%dT%H:%M:%SZ', fv.mtime, 'unixepoch') AS modified,
      fv.mode
    FROM file_versions fv
    JOIN files    f  ON f.id = fv.file_id
    JOIN datasets d  ON d.id = f.dataset_id
    JOIN snapshots s ON s.id = fv.snapshot_id
    WHERE f.path = ? ${DS_FILTER}
    ORDER BY d.name, s.created_at
  `).all(path, ...dsParams);

  const chgs = db.prepare(`
    SELECT
      s.name    AS snapshot,
      strftime('%Y-%m-%dT%H:%M:%SZ', s.created_at, 'unixepoch') AS snapshot_date,
      c.change_type,
      c.old_path,
      c.new_path,
      c.old_size,
      c.new_size,
      c.delta_bytes
    FROM changes c
    JOIN snapshots s ON s.id = c.snapshot_id
    WHERE c.old_path = ? OR c.new_path = ?
    ORDER BY s.created_at
  `).all(path, path);

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
        console.log(`    Size: ${formatSize(v.size)}  Mode: ${v.mode}  Modified: ${v.modified}`);
        if (v.snapshot_path) console.log(`    path: ${v.snapshot_path}`);
      }
    }

    if (chgs.length) {
      console.log('\nChange events:');
      for (const c of chgs) {
        const delta = c.delta_bytes > 0 ? `+${formatSize(c.delta_bytes)}` : formatSize(c.delta_bytes);
        if (c.change_type === 'renamed') {
          console.log(`  [${c.snapshot_date}] RENAMED ${c.old_path} → ${c.new_path}`);
        } else {
          const szOld = c.old_size != null ? formatSize(c.old_size) : '?';
          const szNew = c.new_size != null ? formatSize(c.new_size) : '?';
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
  const datasetName = opts.dataset || null;
  const pathFilter  = opts.path    || null;
  const json        = opts.json    || false;
  const limit       = opts.limit   || 2000;
  const offset      = opts.offset  || 0;

  let pathParam = null;
  if (pathFilter) {
    pathParam = pathFilter.replace(/\*/g, '%').replace(/\?/g, '_');
    if (!pathParam.includes('%') && !pathParam.includes('_')) {
      pathParam += '%';
    }
  }

  const rows = db.prepare(`
    SELECT
      d.name       AS dataset,
      d.mountpoint,
      f.path       AS last_path,
      f.type,
      fv.size,
      s_last.name  AS last_seen_snap,
      strftime('%Y-%m-%dT%H:%M:%SZ', s_last.created_at, 'unixepoch') AS last_seen,
      strftime('%Y-%m-%dT%H:%M:%SZ', s_del.created_at,  'unixepoch') AS deleted_in,
      s_del.name   AS deleted_snapshot
    FROM files f
    JOIN datasets  d      ON d.id  = f.dataset_id
    JOIN snapshots s_last ON s_last.id = f.last_seen_snap_id
    JOIN snapshots s_del  ON s_del.id  = f.deleted_at_snap_id
    JOIN file_versions fv ON fv.file_id = f.id
      AND fv.id = (SELECT id FROM file_versions WHERE file_id = f.id ORDER BY snapshot_id DESC LIMIT 1)
    WHERE f.deleted_at_snap_id IS NOT NULL
      ${datasetName ? 'AND d.name = ?' : ''}
      ${pathParam ? 'AND f.path LIKE ?' : ''}
    ORDER BY s_del.created_at DESC, f.path
    LIMIT ? OFFSET ?
  `).all(
    ...(datasetName ? [datasetName] : []),
    ...(pathParam ? [pathParam] : []),
    limit, offset
  );

  if (!rows.length) { console.log('No deleted files found.'); return { deleted: [] }; }

  for (const r of rows) {
    r.snapshot_path = r.mountpoint ? `${r.mountpoint}/.zfs/snapshot/${r.last_seen_snap}${r.last_path}` : null;
  }

  if (!json) {
    console.log(`\n🗑  Deleted files (${rows.length}):\n`);
    for (const r of rows) {
      console.log(`${r.dataset}  ${r.last_path}  [${r.type}]`);
      console.log(`  Size: ${formatSize(r.size)}  Last seen: ${r.last_seen}  Deleted: ${r.deleted_in} (${r.deleted_snapshot})`);
      if (r.snapshot_path) console.log(`  recover from: ${r.snapshot_path}`);
      console.log('');
    }
  }

  return { deleted: rows };
}

// ─── Changes ────────────────────────────────────────────────────────────────

function changes(db, snapshotName, opts = {}) {
  if (!snapshotName) {
    console.log('Usage: virgo changes <snapshot> [--dataset <name>] [--path <pattern>]');
    return null;
  }

  const json          = opts.json    || false;
  const datasetName   = opts.dataset || null;
  const pathFilterOpt = opts.path    || null;
  const limit         = opts.limit   || 5000;
  const offset        = opts.offset  || 0;

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
  if (datasetName) {
    snap = db.prepare(`
      SELECT s.id, s.full_name, s.created_at
      FROM snapshots s
      JOIN datasets d ON d.id = s.dataset_id
      WHERE (s.name=? OR s.full_name=?) AND d.name = ?
      LIMIT 1
    `).get(snapshotName, snapshotName, datasetName);
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

  if (!snap) { console.log(`Snapshot '${snapshotName}' not found.`); return null; }

  const rows = db.prepare(`
    SELECT c.change_type, c.old_path, c.new_path,
           c.old_size, c.new_size, c.delta_bytes
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

  if (!rows.length) { console.log('No changes recorded for this snapshot.'); return result; }

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
          const delta = r.delta_bytes != null
            ? ` (${r.delta_bytes >= 0 ? '+' : ''}${formatSize(r.delta_bytes)})`
            : '';
          console.log(`    ${r.old_path ?? r.new_path}${delta}`);
        }
      }
      if (items.length > 50) console.log(`    ... and ${items.length - 50} more`);
      console.log('');
    }
  }

  return result;
}

// ─── Diff ───────────────────────────────────────────────────────────────────

function diff(db, snapA, snapB, opts = {}) {
  if (!snapA || !snapB) { console.log('Usage: virgo diff <snap_a> <snap_b>'); return null; }

  const json   = opts.json   || false;
  const limit  = opts.limit  || 5000;
  const offset = opts.offset || 0;

  const sA = db.prepare(`SELECT id FROM snapshots WHERE full_name=? OR name=? LIMIT 1`).get(snapA, snapA);
  const sB = db.prepare(`SELECT id FROM snapshots WHERE full_name=? OR name=? LIMIT 1`).get(snapB, snapB);
  if (!sA) { console.log(`Snapshot '${snapA}' not found.`); return null; }
  if (!sB) { console.log(`Snapshot '${snapB}' not found.`); return null; }
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
      const delta = r.delta >= 0 ? `+${formatSize(r.delta)}` : formatSize(r.delta);
      console.log(`  [${r.status.toUpperCase().padEnd(8)}] ${r.path}  (${delta})`);
    }
  }

  return result;
}

// ─── Reindex ────────────────────────────────────────────────────────────────

function reindex(db, opts = {}) {
  const datasetName = opts.dataset || null;

  if (datasetName) {
    const ds = db.prepare('SELECT id FROM datasets WHERE name = ?').get(datasetName);
    if (!ds) { console.log(`Dataset '${datasetName}' not found.`); return; }

    transaction(db, () => {
      db.prepare('DELETE FROM changes WHERE snapshot_id IN (SELECT id FROM snapshots WHERE dataset_id = ?)').run(ds.id);
      db.prepare('DELETE FROM file_versions WHERE file_id IN (SELECT id FROM files WHERE dataset_id = ?)').run(ds.id);
      db.prepare('DELETE FROM files WHERE dataset_id = ?').run(ds.id);
      db.prepare('UPDATE snapshots SET indexed_at = NULL, diff_done = 0 WHERE dataset_id = ?').run(ds.id);
    });

    console.log(`Reset indexing state for ${datasetName}. Run 'virgo index' to rebuild.`);
  } else {
    transaction(db, () => {
      db.exec('DELETE FROM changes');
      db.exec('DELETE FROM file_versions');
      db.exec('DELETE FROM files');
      db.exec('UPDATE snapshots SET indexed_at = NULL, diff_done = 0');
    });

    console.log("Reset all indexing state. Run 'virgo index' to rebuild.");
  }
}

// ─── Stats ──────────────────────────────────────────────────────────────────

function stats(db, opts = {}) {
  const json = opts.json || false;

  const s = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM datasets)      AS datasets,
      (SELECT COUNT(*) FROM snapshots)     AS snapshots,
      (SELECT COUNT(*) FROM snapshots WHERE indexed_at IS NOT NULL) AS indexed,
      (SELECT COUNT(*) FROM files)         AS files,
      (SELECT COUNT(*) FROM file_versions) AS versions,
      (SELECT COUNT(*) FROM changes)       AS changes,
      (SELECT COUNT(*) FROM files WHERE deleted_at_snap_id IS NOT NULL) AS deleted,
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

  const result = { ...s, top_datasets: topDatasets };

  if (!json) {
    console.log('\n📊 ZFS Index Statistics\n');
    console.log(`   DB size:        ${formatSize(s.db_bytes)}`);
    console.log(`   Datasets:       ${s.datasets}`);
    console.log(`   Snapshots:      ${s.snapshots} (${s.indexed} indexed)`);
    console.log(`   Unique files:   ${s.files.toLocaleString()}`);
    console.log(`   File versions:  ${s.versions.toLocaleString()}`);
    console.log(`   Change events:  ${s.changes.toLocaleString()}`);
    console.log(`   Deleted files:  ${s.deleted.toLocaleString()}`);
    console.log('\n   Top datasets by file count:');
    for (const d of topDatasets) {
      console.log(`     ${d.name.padEnd(30)} ${d.file_count.toLocaleString()} files / ${d.snap_count} snapshots`);
    }
  }

  return result;
}

module.exports = { open, search, history, deleted, changes, diff, reindex, stats };
