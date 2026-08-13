import * as database from '../indexer/db.js';

/** Runs a query against the index and prints it. Without an index there is nothing to query and the
 * empty answer is the true one, so every command reports it the same way instead of failing. */
const query = async (options, empty, run) => {
	const db = database.open();
	if (!db) {
		if (options.json) {
			console.log(JSON.stringify(empty, null, 2));
		}
		return;
	}

	try {
		const result = run(await import('../indexer/query.js'), db);
		if (options.json) {
			console.log(JSON.stringify(result, null, 2));
		}
	} finally {
		db.close();
	}
};

const register = (program) => {
	const indexerCmd = program
		.command('indexer')
		.description('Index and search files in ZFS snapshots');

	// ─── index ──────────────────────────────────────────────────────────────

	indexerCmd
		.command('index')
		.description('Index ZFS datasets and snapshots (uses configured indexer paths)')
		.action(async (options) => {
			const indexer = await import('../indexer/index.js');
			indexer.run(options).catch((err) => {
				console.error(err);
				process.exitCode = 1;
			});
		});

	// ─── reindex ────────────────────────────────────────────────────────────

	indexerCmd
		.command('reindex')
		.description('Clear indexed data and force a full re-crawl on next run')
		.option('--dataset <names>', 'Dataset root(s), comma-separated; reset each root and its children')
		.action(async (options) => {
			await query(options, null, (indexer, db) => { return indexer.reindex(db, options); });
		});

	// ─── search ─────────────────────────────────────────────────────────────

	indexerCmd
		.command('search <term>')
		.description('Search files by path (glob with * ? or keywords)')
		.option('--dataset <names>', 'Limit to dataset root(s), comma-separated (each matches that dataset and children)')
		.option('--path <pattern>', 'Filter by path (prefix or glob with * ?)')
		.option('--type <type>', 'Filter by type: file, dir, link')
		.option('--min-size <bytes>', 'Minimum file size in bytes', parseInt)
		.option('--max-size <bytes>', 'Maximum file size in bytes', parseInt)
		.option('--since <date>', 'Files modified after this date (ISO 8601)')
		.option('--until <date>', 'Files modified before this date (ISO 8601)')
		.option('--limit <n>', 'Max results (default 100)', parseInt)
		.option('--offset <n>', 'Skip first N results', parseInt)
		.option('--json', 'Output as JSON')
		.action(async (term, options) => {
			await query(options, [], (indexer, db) => { return indexer.search(db, term, options); });
		});

	// ─── history ────────────────────────────────────────────────────────────

	indexerCmd
		.command('history <path>')
		.description('Full version history of a file')
		.option('--dataset <names>', 'Limit to dataset root(s), comma-separated (each matches that dataset and children)')
		.option('--json', 'Output as JSON')
		.action(async (path, options) => {
			await query(options, [], (indexer, db) => { return indexer.history(db, path, options); });
		});

	// ─── deleted ──────────────────────────────────────────────────────────

	indexerCmd
		.command('deleted')
		.description('List deleted files')
		.option('--dataset <names>', 'Limit to dataset root(s), comma-separated (each matches that dataset and children)')
		.option('--path <pattern>', 'Filter by path (prefix or glob with * ?)')
		.option('--limit <n>', 'Max results (default 2000)', parseInt)
		.option('--offset <n>', 'Skip first N results', parseInt)
		.option('--json', 'Output as JSON')
		.action(async (options) => {
			await query(options, [], (indexer, db) => { return indexer.deleted(db, options); });
		});

	// ─── changes ────────────────────────────────────────────────────────────

	indexerCmd
		.command('changes <snapshot>')
		.description('Show all changes in a snapshot')
		.option('--dataset <names>', 'Resolve snapshot within these dataset root(s), comma-separated')
		.option('--path <pattern>', 'Filter by path (prefix or glob with * ?); matches old or new path')
		.option('--limit <n>', 'Max results (default 5000)', parseInt)
		.option('--offset <n>', 'Skip first N results', parseInt)
		.option('--json', 'Output as JSON')
		.action(async (snapshot, options) => {
			await query(options, [], (indexer, db) => { return indexer.changes(db, snapshot, options); });
		});

	// ─── diff ───────────────────────────────────────────────────────────────

	indexerCmd
		.command('diff <snapA> <snapB>')
		.description('Changes between two snapshots')
		.option('--limit <n>', 'Max results (default 5000)', parseInt)
		.option('--offset <n>', 'Skip first N results', parseInt)
		.option('--json', 'Output as JSON')
		.action(async (snapA, snapB, options) => {
			await query(options, [], (indexer, db) => { return indexer.diff(db, snapA, snapB, options); });
		});

	// ─── stats ──────────────────────────────────────────────────────────────

	indexerCmd
		.command('stats')
		.description('Index statistics')
		.option('--json', 'Output as JSON')
		.action(async (options) => {
			await query(options, {}, (indexer, db) => { return indexer.stats(db, options); });
		});
};

export default register;
