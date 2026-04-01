'use strict';

const { openDb, transaction } = require('./db');
const { discoverAll, diffSnapshots, snapshotMountPath } = require('./zfs');
const { walkSnapshot } = require('./walker');
const { getConfig } = require('./config');
const { execaSync } = require('execa');
const { statSync } = require('fs');

// ─── Dataset filtering ─────────────────────────────────────────────────────

function patternToMatcher(pattern) {
  if (pattern.includes('*') || pattern.includes('?')) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('^' + escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '(/.*)?$');
    return name => re.test(name);
  }
  return name => name === pattern || name.startsWith(pattern + '/');
}

function datasetAllowed(name, config, excludeMatchers) {
  if (excludeMatchers.some(fn => fn(name))) return false;
  if (config.DATASET) return name === config.DATASET;
  if (config.DATASETS.length) return config.DATASETS.some(p => name === p || name.startsWith(p + '/'));
  return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function umountSnapshot(snapPath) {
  try { execaSync('umount', [snapPath]); } catch {}
}

function safeStat(path) {
  try { return statSync(path); } catch { return null; }
}

function formatSize(bytes) {
  if (bytes == null) return '?';
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${bytes}B`;
  if (abs < 1024**2) return `${(bytes/1024).toFixed(1)}K`;
  if (abs < 1024**3) return `${(bytes/1024**2).toFixed(1)}M`;
  return `${(bytes/1024**3).toFixed(2)}G`;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms/1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(0);
  return `${m}m${s}s`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(opts = {}) {
  const config = getConfig(opts);

  if (!config.DATASETS.length && !config.DATASET) {
    console.error('Fatal: DATASETS not configured. Set DATASETS in indexer/.env');
    process.exitCode = 1;
    return;
  }

  const pool = (config.DATASET ?? config.DATASETS[0]).split('/')[0];
  const excludeMatchers = config.EXCLUDE_DATASETS.map(patternToMatcher);

  const db = openDb(config.DB_PATH);

  const perf = {
    t0: Date.now(), snapsCrawled: 0, snapsIncremental: 0, snapsSkipped: 0,
    diffsDone: 0, filesCrawled: 0, crawlMs: 0, diffMs: 0,
    sqlInserts: 0, sqlUpserts: 0, sqlSelects: 0, sqlUpdates: 0, sqlTxns: 0, sqlMs: 0,
    diffChanges: 0,
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
    insertVersion: db.prepare(`INSERT OR IGNORE INTO file_versions(file_id, snapshot_id, path, size, mtime, ctime, nlink, mode) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`),
    getFileByPath: db.prepare(`SELECT id FROM files WHERE dataset_id = ? AND path = ?`),
    getLatestSize: db.prepare(`SELECT size FROM file_versions WHERE file_id = ? ORDER BY snapshot_id DESC LIMIT 1`),
    getSizeAtSnapshot: db.prepare(`SELECT size FROM file_versions WHERE file_id = ? AND snapshot_id = ? LIMIT 1`),
    getSizeByPathAtSnapshot: db.prepare(`SELECT fv.size FROM file_versions fv JOIN files f ON f.id = fv.file_id WHERE f.dataset_id = ? AND fv.path = ? AND fv.snapshot_id = ? LIMIT 1`),
    markDeleted: db.prepare(`UPDATE files SET deleted_at_snap_id = ? WHERE id = ? AND deleted_at_snap_id IS NULL`),
    insertChange: db.prepare(`INSERT INTO changes(snapshot_id, file_id, change_type, old_path, new_path, old_size, new_size, delta_bytes, changed_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    bumpLastSeen: db.prepare(`UPDATE files SET last_seen_snap_id = ? WHERE dataset_id = ? AND deleted_at_snap_id IS NULL`),
    deleteChangesBySnapshot: db.prepare(`DELETE FROM changes WHERE snapshot_id = ?`),
    deleteVersionsBySnapshot: db.prepare(`DELETE FROM file_versions WHERE snapshot_id = ?`),
    clearFirstSeen: db.prepare(`UPDATE files SET first_seen_snap_id = NULL WHERE first_seen_snap_id = ?`),
    clearLastSeen: db.prepare(`UPDATE files SET last_seen_snap_id = NULL WHERE last_seen_snap_id = ?`),
    clearDeletedAt: db.prepare(`UPDATE files SET deleted_at_snap_id = NULL WHERE deleted_at_snap_id = ?`),
    deleteSnapshot: db.prepare(`DELETE FROM snapshots WHERE id = ?`),
    deleteOrphanedFiles: db.prepare(`DELETE FROM files WHERE id NOT IN (SELECT DISTINCT file_id FROM file_versions)`),
  };

  try {
    console.log('🔍 Discovering ZFS datasets and snapshots...');
    console.log(`   Pool: ${pool}`);
    if (config.DATASETS.length) console.log(`   Include: ${config.DATASETS.join(', ')}`);
    if (config.EXCLUDE_DATASETS.length) console.log(`   Exclude: ${config.EXCLUDE_DATASETS.join(', ')}`);

    const { datasets, snapshots } = discoverAll({ pool });
    const filteredDatasets = datasets.filter(d => datasetAllowed(d.name, config, excludeMatchers));

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
      if (!dsId) continue;
      const row = stmt.upsertSnapshot.get(dsId, s.name, s.full_name, s.created_at, s.used_bytes, s.referenced_bytes);
      if (row) { snapshotIds[s.full_name] = row.id; }
      else {
        const existing = stmt.getSnapshotByFullName.get(s.full_name);
        if (existing) snapshotIds[s.full_name] = existing.id;
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
    stmt.deleteOrphanedFiles.run();

    // Index snapshots
    for (const d of filteredDatasets) {
      const dsId = datasetIds[d.name];
      const dsSnaps = stmt.getSnapshotsForDataset.all(dsId);
      console.log(`\n📦 Dataset: ${d.name} (${dsSnaps.length} snapshots)`);

      let prevSnap = null;
      for (const snap of dsSnaps) {
        const snapPath = snapshotMountPath(d.mountpoint, snap.name);

        if (!snap.indexed_at) {
          if (!snapPath) { prevSnap = snap; continue; }

          if (prevSnap && prevSnap.indexed_at) {
            const t = Date.now();
            await doIncremental(db, stmt, perf, prevSnap, snap, dsId, d.mountpoint, snapPath);
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

        if (prevSnap && !snap.diff_done) {
          console.log(`  ↔️  diff ${prevSnap.name} → ${snap.name}`);
          const t = Date.now();
          await doDiff(db, stmt, perf, prevSnap, snap, dsId, d.mountpoint);
          perf.diffMs += Date.now() - t;
          perf.diffsDone++;
          stmt.markDiffDone.run(snap.id);
        }

        prevSnap = snap;
      }
    }

    console.log('\n✅ Indexing complete.');
    printStats(db, perf);
  } finally {
    db.close();
  }
}

// ─── Full crawl ─────────────────────────────────────────────────────────────

async function doCrawl(db, stmt, perf, snapId, datasetId, snapPath, fullName) {
  console.log(`  🕷  Full crawl ${fullName}...`);
  let count = 0;
  const t0 = Date.now();

  await walkSnapshot(snapPath, (batch) => {
    if (batch === null) return;
    const t = Date.now();
    transaction(db, () => {
      perf.sqlTxns++;
      for (const e of batch) {
        const fileRow = stmt.upsertFile.get(datasetId, e.path, e.inode, e.type, snapId, snapId);
        perf.sqlUpserts++;
        if (!fileRow) continue;
        stmt.insertVersion.run(fileRow.id, snapId, e.path, e.size, e.mtime, e.ctime, e.nlink, e.mode);
        perf.sqlInserts++;
      }
    });
    perf.sqlMs += Date.now() - t;
    count += batch.length;
    if (count % 50000 === 0) {
      process.stdout.write(`\r    ${count.toLocaleString()} entries @ ${(count / ((Date.now() - t0) / 1000)).toFixed(0)}/s   `);
    }
  });

  console.log(`\n    Done: ${count.toLocaleString()} entries in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  return count;
}

// ─── Incremental ────────────────────────────────────────────────────────────

async function doIncremental(db, stmt, perf, prevSnap, snap, datasetId, mountpoint, snapPath) {
  console.log(`  ⚡ Incremental ${snap.name} (from ${prevSnap.name})...`);
  const t0 = Date.now();

  let t = Date.now();
  stmt.bumpLastSeen.run(snap.id, datasetId);
  perf.sqlUpdates++;
  perf.sqlMs += Date.now() - t;

  let changeCount = 0;
  for await (const c of diffSnapshots(prevSnap.full_name, snap.full_name)) {
    const relPath = mountpoint && c.path.startsWith(mountpoint) ? c.path.slice(mountpoint.length) || '/' : c.path;

    t = Date.now();
    transaction(db, () => {
      perf.sqlTxns++;

      if (c.changeType === 'added') {
        const st = safeStat(snapPath + relPath);
        if (st) {
          const type = st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : 'other';
          const fileRow = stmt.upsertFile.get(datasetId, relPath, st.ino, type, snap.id, snap.id);
          perf.sqlUpserts++;
          if (fileRow) {
            stmt.insertVersion.run(fileRow.id, snap.id, relPath, st.isDirectory() ? 0 : st.size, Math.floor(st.mtimeMs / 1000), Math.floor(st.ctimeMs / 1000), st.nlink, (st.mode & 0o7777).toString(8).padStart(4, '0'));
            perf.sqlInserts++;
          }
        }
      } else if (c.changeType === 'removed') {
        const fileRow = stmt.getFileByPath.get(datasetId, relPath);
        perf.sqlSelects++;
        if (fileRow) { stmt.markDeleted.run(snap.id, fileRow.id); perf.sqlUpdates++; }
      } else if (c.changeType === 'modified') {
        const st = safeStat(snapPath + relPath);
        if (st) {
          const fileRow = stmt.getFileByPath.get(datasetId, relPath);
          perf.sqlSelects++;
          if (fileRow) {
            stmt.insertVersion.run(fileRow.id, snap.id, relPath, st.isDirectory() ? 0 : st.size, Math.floor(st.mtimeMs / 1000), Math.floor(st.ctimeMs / 1000), st.nlink, (st.mode & 0o7777).toString(8).padStart(4, '0'));
            perf.sqlInserts++;
          }
        }
      } else if (c.changeType === 'renamed') {
        const relNewPath = c.newPath && mountpoint && c.newPath.startsWith(mountpoint) ? c.newPath.slice(mountpoint.length) || '/' : c.newPath;
        const st = safeStat(snapPath + (relNewPath ?? relPath));
        if (st) {
          const oldFile = stmt.getFileByPath.get(datasetId, relPath);
          perf.sqlSelects++;
          if (oldFile) { stmt.markDeleted.run(snap.id, oldFile.id); perf.sqlUpdates++; }
          const type = st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : 'other';
          const newFile = stmt.upsertFile.get(datasetId, relNewPath ?? relPath, st.ino, type, snap.id, snap.id);
          perf.sqlUpserts++;
          if (newFile) {
            stmt.insertVersion.run(newFile.id, snap.id, relNewPath ?? relPath, st.isDirectory() ? 0 : st.size, Math.floor(st.mtimeMs / 1000), Math.floor(st.ctimeMs / 1000), st.nlink, (st.mode & 0o7777).toString(8).padStart(4, '0'));
            perf.sqlInserts++;
          }
        }
      }
    });
    perf.sqlMs += Date.now() - t;
    changeCount++;
  }

  console.log(`    Done: ${changeCount} changes in ${((Date.now()-t0)/1000).toFixed(1)}s`);
}

// ─── Diff for changes table ─────────────────────────────────────────────────

async function doDiff(db, stmt, perf, prevSnap, snap, datasetId, mountpoint) {
  const changes = [];
  for await (const change of diffSnapshots(prevSnap.full_name, snap.full_name)) {
    changes.push(change);
    if (changes.length >= 1000) flushChanges(db, stmt, perf, changes.splice(0), snap, datasetId, mountpoint);
  }
  if (changes.length) flushChanges(db, stmt, perf, changes, snap, datasetId, mountpoint);
}

function flushChanges(db, stmt, perf, changes, snap, datasetId, mountpoint) {
  const t = Date.now();
  transaction(db, () => {
    perf.sqlTxns++;
    for (const c of changes) {
      const relPath = mountpoint && c.path.startsWith(mountpoint) ? c.path.slice(mountpoint.length) || '/' : c.path;
      const relNewPath = c.newPath && mountpoint && c.newPath.startsWith(mountpoint) ? c.newPath.slice(mountpoint.length) || '/' : c.newPath;

      const fileRow = stmt.getFileByPath.get(datasetId, relPath);
      let fileId = fileRow?.id ?? null;
      perf.sqlSelects++;

      let oldSize = null, newSize = null;
      if (c.changeType === 'removed') {
        if (fileId) { oldSize = stmt.getLatestSize.get(fileId)?.size ?? null; perf.sqlSelects++; }
      } else if (c.changeType === 'added') {
        if (fileId) { newSize = stmt.getSizeAtSnapshot.get(fileId, snap.id)?.size ?? null; perf.sqlSelects++; }
        if (newSize == null) { newSize = stmt.getSizeByPathAtSnapshot.get(datasetId, relPath, snap.id)?.size ?? null; perf.sqlSelects++; }
      } else {
        if (fileId) {
          oldSize = stmt.getLatestSize.get(fileId)?.size ?? null;
          newSize = stmt.getSizeAtSnapshot.get(fileId, snap.id)?.size ?? null;
          perf.sqlSelects += 2;
        }
      }

      if (c.changeType === 'removed' && fileId) { stmt.markDeleted.run(snap.id, fileId); perf.sqlUpdates++; }

      stmt.insertChange.run(snap.id, fileId, c.changeType, relPath, c.changeType === 'renamed' ? relNewPath : null, oldSize, newSize, (newSize ?? 0) - (oldSize ?? 0), snap.created_at);
      perf.sqlInserts++;
      perf.diffChanges++;
    }
  });
  perf.sqlMs += Date.now() - t;
}

// ─── Stats ──────────────────────────────────────────────────────────────────

function printStats(db, perf) {
  const totalMs = Date.now() - perf.t0;
  const stats = db.prepare(`SELECT (SELECT COUNT(*) FROM datasets) AS datasets, (SELECT COUNT(*) FROM snapshots) AS snapshots, (SELECT COUNT(*) FROM files) AS files, (SELECT COUNT(*) FROM file_versions) AS versions, (SELECT COUNT(*) FROM changes) AS changes, (SELECT COUNT(*) FROM files WHERE deleted_at_snap_id IS NOT NULL) AS deleted`).get();

  const pgSz = Object.values(db.prepare('SELECT * FROM pragma_page_size()').get())[0];
  const pgCount = Object.values(db.prepare('SELECT * FROM pragma_page_count()').get())[0];
  const pgFree = Object.values(db.prepare('SELECT * FROM pragma_freelist_count()').get())[0];
  const jMode = Object.values(db.prepare('SELECT * FROM pragma_journal_mode()').get())[0];
  const cSz = Object.values(db.prepare('SELECT * FROM pragma_cache_size()').get())[0];

  console.log('\n📊 Index stats:');
  console.log(`   Datasets:      ${stats.datasets}`);
  console.log(`   Snapshots:     ${stats.snapshots}`);
  console.log(`   Unique files:  ${stats.files.toLocaleString()}`);
  console.log(`   File versions: ${stats.versions.toLocaleString()}`);
  console.log(`   Change events: ${stats.changes.toLocaleString()}`);
  console.log(`   Deleted files: ${stats.deleted.toLocaleString()}`);

  console.log('\n💾 SQLite:');
  console.log(`   DB size:       ${formatSize(pgSz * pgCount)}`);
  console.log(`   Used:          ${formatSize(pgSz * (pgCount - pgFree))} (${pgCount - pgFree} pages)`);
  console.log(`   Free:          ${formatSize(pgSz * pgFree)} (${pgFree} pages)`);
  console.log(`   Page size:     ${formatSize(pgSz)}`);
  console.log(`   Journal mode:  ${jMode}`);
  console.log(`   Cache size:    ${Math.abs(cSz)}${cSz < 0 ? 'KiB' : ' pages'}`);

  console.log('\n⏱  Performance:');
  console.log(`   Total runtime:   ${formatDuration(totalMs)}`);
  console.log(`   Crawl time:      ${formatDuration(perf.crawlMs)}`);
  console.log(`   Diff time:       ${formatDuration(perf.diffMs)}`);
  console.log(`   Full crawls:     ${perf.snapsCrawled}`);
  console.log(`   Incremental:     ${perf.snapsIncremental}`);
  console.log(`   Skipped:         ${perf.snapsSkipped}`);
  console.log(`   Diffs processed: ${perf.diffsDone}`);
  console.log(`   Diff changes:    ${perf.diffChanges.toLocaleString()}`);
  console.log(`   Files crawled:   ${perf.filesCrawled.toLocaleString()}`);
  if (perf.crawlMs > 0 && perf.filesCrawled > 0) console.log(`   Crawl rate:      ${(perf.filesCrawled / (perf.crawlMs / 1000)).toFixed(0)} files/s`);

  const totalOps = perf.sqlInserts + perf.sqlUpserts + perf.sqlSelects + perf.sqlUpdates;
  console.log('\n🗄  SQL:');
  console.log(`   Total queries:   ${totalOps.toLocaleString()}`);
  console.log(`   Inserts:         ${perf.sqlInserts.toLocaleString()}`);
  console.log(`   Upserts:         ${perf.sqlUpserts.toLocaleString()}`);
  console.log(`   Selects:         ${perf.sqlSelects.toLocaleString()}`);
  console.log(`   Updates:         ${perf.sqlUpdates.toLocaleString()}`);
  console.log(`   Transactions:    ${perf.sqlTxns.toLocaleString()}`);
  console.log(`   SQL time:        ${formatDuration(perf.sqlMs)}`);
  if (totalMs > 0) console.log(`   SQL % of total:  ${(perf.sqlMs / totalMs * 100).toFixed(1)}%`);
  if (perf.sqlMs > 0 && totalOps > 0) {
    console.log(`   SQL ops/s:       ${(totalOps / (perf.sqlMs / 1000)).toFixed(0)}`);
    console.log(`   Avg per op:      ${(perf.sqlMs / totalOps * 1000).toFixed(1)}μs`);
  }
}

module.exports = { run };
