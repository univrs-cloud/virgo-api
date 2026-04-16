'use strict';

const { openDb } = require('../indexer/db');

const register = (program) => {
	const indexerCmd = program
		.command('indexer')
		.description('Index and search files in ZFS snapshots');

	// ─── index ──────────────────────────────────────────────────────────────

	indexerCmd
		.command('index')
		.description('Index ZFS datasets and snapshots (uses configured indexer paths)')
		.action((opts) => {
			const indexer = require('../indexer/index');
			indexer.run(opts).catch((err) => {
				console.error(err);
				process.exitCode = 1;
			});
		});

	// ─── reindex ────────────────────────────────────────────────────────────

	indexerCmd
		.command('reindex')
		.description('Clear indexed data and force a full re-crawl on next run')
		.option('--dataset <names>', 'Dataset root(s), comma-separated; reset each root and its children')
		.action((opts) => {
			const query = require('../indexer/query');
			const db = openDb();
			try {
				query.reindex(db, opts);
			} finally {
				db.close();
			}
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
		.action((term, opts) => {
			const query = require('../indexer/query');
			const db = openDb();
			try {
				const result = query.search(db, term, opts);
				if (opts.json) console.log(JSON.stringify(result, null, 2));
			} finally {
				db.close();
			}
		});

	// ─── history ────────────────────────────────────────────────────────────

	indexerCmd
		.command('history <path>')
		.description('Full version history of a file')
		.option('--dataset <names>', 'Limit to dataset root(s), comma-separated (each matches that dataset and children)')
		.option('--json', 'Output as JSON')
		.action((path, opts) => {
			const query = require('../indexer/query');
			const db = openDb();
			try {
				const result = query.history(db, path, opts);
				if (opts.json) console.log(JSON.stringify(result, null, 2));
			} finally {
				db.close();
			}
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
		.action((opts) => {
			const query = require('../indexer/query');
			const db = openDb();
			try {
				const result = query.deleted(db, opts);
				if (opts.json) console.log(JSON.stringify(result, null, 2));
			} finally {
				db.close();
			}
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
		.action((snapshot, opts) => {
			const query = require('../indexer/query');
			const db = openDb();
			try {
				const result = query.changes(db, snapshot, opts);
				if (opts.json) console.log(JSON.stringify(result, null, 2));
			} finally {
				db.close();
			}
		});

	// ─── diff ───────────────────────────────────────────────────────────────

	indexerCmd
		.command('diff <snapA> <snapB>')
		.description('Changes between two snapshots')
		.option('--limit <n>', 'Max results (default 5000)', parseInt)
		.option('--offset <n>', 'Skip first N results', parseInt)
		.option('--json', 'Output as JSON')
		.action((snapA, snapB, opts) => {
			const query = require('../indexer/query');
			const db = openDb();
			try {
				const result = query.diff(db, snapA, snapB, opts);
				if (opts.json) console.log(JSON.stringify(result, null, 2));
			} finally {
				db.close();
			}
		});

	// ─── stats ──────────────────────────────────────────────────────────────

	indexerCmd
		.command('stats')
		.description('Index statistics')
		.option('--json', 'Output as JSON')
		.action((opts) => {
			const query = require('../indexer/query');
			const db = openDb();
			try {
				const result = query.stats(db, opts);
				if (opts.json) console.log(JSON.stringify(result, null, 2));
			} finally {
				db.close();
			}
		});
};

module.exports = register;
