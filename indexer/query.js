'use strict';

const { openDb } = require('./db');
const { getConfig } = require('./config');

// ─── Open DB helper for bin entry point ─────────────────────────────────────

function open(dbPath) {
  const config = getConfig({ db: dbPath });
  return openDb(config.DB_PATH);
}

// ─── Search ─────────────────────────────────────────────────────────────────

function search(db, pattern, opts = {}) {
  if (!pattern) { console.log('Usage: virgo search <term> [--dataset <n>] [--type file|dir]'); return null; }

  const datasetFilter = opts.dataset || null;
  const typeFilter    = opts.type    || null;
  const json          = opts.json    || false;

  const ID_JOINS = `
    JOIN files    f ON f.id = fv.file_id
    JOIN datasets d ON d.id = f.dataset_id`;

  const DS_FILTER   = datasetFilter ? `AND d.name LIKE ?` : '';
  const TYPE_FILTER = typeFilter    ? `AND f.type = ?`    : '';
  const dsParam     = datasetFilter
    ? (datasetFilter.includes('/') ? datasetFilter : '%' + datasetFilter)
    : null;
  const extraParams = [dsParam, typeFilter].filter(Boolean);

  let fileIds;
  if (pattern.includes('*') || pattern.includes('?')) {
    let glob = pattern.replace(/\*/g, '%').replace(/\?/g, '_');
    if (!glob.startsWith('%') && !glob.startsWith('/')) glob = '%' + glob;
    if (!glob.endsWith('%')) glob = glob + '%';
    fileIds = db.prepare(`SELECT DISTINCT f.id FROM file_versions fv ${ID_JOINS} WHERE fv.path LIKE ? ${DS_FILTER} ${TYPE_FILTER} LIMIT 100`).all(glob, ...extraParams);
  } else {
    const ftsQuery = '"' + pattern.replace(/"/g, '""') + '"';
    try {
      fileIds = db.prepare(`SELECT DISTINCT f.id FROM fts_paths fp JOIN file_versions fv ON fv.id = fp.rowid ${ID_JOINS} WHERE fts_paths MATCH ? ${DS_FILTER} ${TYPE_FILTER} LIMIT 100`).all(ftsQuery, ...extraParams);
    } catch { fileIds = []; }

    if (!fileIds.length) {
      fileIds = db.prepare(`SELECT DISTINCT f.id FROM file_versions fv ${ID_JOINS} WHERE fv.path LIKE ? ${DS_FILTER} ${TYPE_FILTER} LIMIT 100`).all('%' + pattern + '%', ...extraParams);
    }
  }

  if (!fileIds.length) { console.log('No results.'); return []; }

  const ids = fileIds.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');

  const rows = db.prepare(`
    SELECT
      f.id AS file_id,
      d.name AS dataset, d.mountpoint, fv.path, f.type, fv.size, fv.mtime,
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
    ORDER BY d.name, fv.path, s.created_at
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
  if (!path) { console.log('Usage: virgo history <path>'); return null; }

  const json = opts.json || false;

  const versions = db.prepare(`
    SELECT
      d.name       AS dataset,
      d.mountpoint,
      s.name       AS snapshot,
      s.full_name,
      strftime('%Y-%m-%dT%H:%M:%SZ', s.created_at, 'unixepoch') AS snapshot_date,
      fv.path,
      fv.size,
      strftime('%Y-%m-%dT%H:%M:%SZ', fv.mtime, 'unixepoch') AS modified,
      fv.mode
    FROM file_versions fv
    JOIN files    f  ON f.id = fv.file_id
    JOIN datasets d  ON d.id = f.dataset_id
    JOIN snapshots s ON s.id = fv.snapshot_id
    WHERE fv.path = ?
    ORDER BY d.name, s.created_at
  `).all(path);

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
  const json        = opts.json    || false;

  const rows = db.prepare(`
    SELECT
      d.name       AS dataset,
      d.mountpoint,
      fv.path      AS last_path,
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
      ${datasetName ? 'AND d.name LIKE ?' : ''}
    ORDER BY s_del.created_at DESC, fv.path
    LIMIT 2000
  `).all(...(datasetName
    ? [datasetName.includes('/') ? datasetName : '%' + datasetName]
    : []));

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
  if (!snapshotName) { console.log('Usage: virgo changes <snapshot>'); return null; }

  const json = opts.json || false;

  const snap = db.prepare(
    `SELECT id, full_name, created_at FROM snapshots WHERE name=? OR full_name=? LIMIT 1`
  ).get(snapshotName, snapshotName);
  if (!snap) { console.log(`Snapshot '${snapshotName}' not found.`); return null; }

  const rows = db.prepare(`
    SELECT c.change_type, c.old_path, c.new_path,
           c.old_size, c.new_size, c.delta_bytes
    FROM changes c
    WHERE c.snapshot_id = ?
    ORDER BY c.change_type, c.new_path, c.old_path
  `).all(snap.id);

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

  const json = opts.json || false;

  const rows = db.prepare(`
    SELECT path, size_a, size_b, delta, status FROM (
      SELECT
        fv_b.path,
        fv_a.size AS size_a,
        fv_b.size AS size_b,
        (fv_b.size - COALESCE(fv_a.size, 0)) AS delta,
        CASE
          WHEN fv_a.file_id IS NULL THEN 'added'
          WHEN fv_b.mtime != fv_a.mtime THEN 'modified'
          ELSE 'unchanged'
        END AS status
      FROM file_versions fv_b
      JOIN snapshots s_b ON s_b.id = fv_b.snapshot_id AND (s_b.name=? OR s_b.full_name=?)
      LEFT JOIN snapshots s_a ON (s_a.name=? OR s_a.full_name=?)
      LEFT JOIN file_versions fv_a ON fv_a.file_id = fv_b.file_id AND fv_a.snapshot_id = s_a.id
    )
    WHERE status != 'unchanged'
    ORDER BY status, path
    LIMIT 5000
  `).all(snapB, snapB, snapA, snapA);

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
    SELECT d.name, COUNT(f.id) AS file_count, COUNT(DISTINCT s.id) AS snap_count
    FROM datasets d
    LEFT JOIN files f     ON f.dataset_id = d.id
    LEFT JOIN snapshots s ON s.dataset_id = d.id
    GROUP BY d.id ORDER BY file_count DESC LIMIT 10
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatSize(bytes) {
  if (bytes == null) return '?';
  const abs = Math.abs(bytes);
  const sign = bytes < 0 ? '-' : '';
  if (abs < 1024) return `${sign}${abs}B`;
  if (abs < 1024**2) return `${sign}${(abs/1024).toFixed(1)}K`;
  if (abs < 1024**3) return `${sign}${(abs/1024**2).toFixed(1)}M`;
  return `${sign}${(abs/1024**3).toFixed(2)}G`;
}

module.exports = { open, search, history, deleted, changes, diff, stats };
