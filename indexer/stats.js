import * as utils from './utils.js';

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

export { changeTypeBreakdown, printStats };
