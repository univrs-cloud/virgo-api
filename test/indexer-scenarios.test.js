import assert from 'node:assert/strict';
import test from 'node:test';
import * as database from '../indexer/db.js';
import { createSnapshotContext, finishSnapshot, flushIncrementalBatch, flushUnifiedBatch } from '../indexer/flush.js';
import { diff, since } from '../indexer/query.js';
import { isInScope } from '../indexer/scope.js';
import { FILES, fixture, seed, performanceCounters, eventOrders } from './helpers/indexer-fixture.js';

const TRASH = '/data/user/files_trashbin/files';

// Scenarios specify filesystem operations, never hand-authored change events.
const scenarios = [
	{
		name: 'edit a file',
		before: async (fs) => { await fs.write('a', 'old'); },
		after: async (fs) => { await fs.write('a', 'changed'); },
	},
	{
		name: 'create a file',
		before: async () => {},
		after: async (fs) => { await fs.write('a', 'new'); },
	},
	{
		name: 'delete a file',
		before: async (fs) => { await fs.write('a', 'old'); await fs.write('keep', 'kept'); },
		after: async (fs) => { await fs.remove('a'); },
	},
	{
		name: 'rename a file',
		before: async (fs) => { await fs.write('a', 'old'); },
		after: async (fs) => { await fs.move('a', 'b'); },
	},
	{
		name: 'rename and edit a file',
		before: async (fs) => { await fs.write('a', 'old'); },
		after: async (fs) => { await fs.move('a', 'b'); await fs.write('b', 'changed'); },
	},
	{
		name: 'delete and recreate a file',
		before: async (fs) => { await fs.write('a', 'old contents'); },
		after: async (fs) => { await fs.remove('a'); await fs.write('a', 'new'); },
	},
	{
		name: 'move a destination aside, then reuse its name',
		before: async (fs) => { await fs.write('a', 'aaaaa'); await fs.write('b', 'bbbbbbbb'); },
		after: async (fs) => { await fs.move('b', 'c'); await fs.move('a', 'b'); },
	},
	{
		name: 'swap two files',
		before: async (fs) => { await fs.write('a', 'aaaaa'); await fs.write('b', 'bbbbbbbb'); },
		after: async (fs) => { await fs.move('a', 'tmp'); await fs.move('b', 'a'); await fs.move('tmp', 'b'); },
	},
	{
		name: 'rotate three files',
		before: async (fs) => { await fs.write('a', 'a'); await fs.write('b', 'bb'); await fs.write('c', 'ccc'); },
		after: async (fs) => { await fs.move('c', 'tmp'); await fs.move('b', 'c'); await fs.move('a', 'b'); await fs.move('tmp', 'a'); },
	},
	{
		name: 'rename a file away and create a new one under its name',
		before: async (fs) => { await fs.write('b', 'bbbbbbbb'); },
		after: async (fs) => { await fs.move('b', 'c'); await fs.write('b', 'new'); },
	},
	{
		name: 'rename a file over an existing file',
		before: async (fs) => { await fs.write('a', 'aaaaa'); await fs.write('b', 'bbbbbbbb'); },
		after: async (fs) => { await fs.move('a', 'b'); },
		check: (db) => {
			const result = diff(db, 's1', 's2', { json: true });
			assert.ok(result.files.some((f) => f.path === `${FILES}/b` && f.status === 'renamed'));
			assert.ok(result.files.some((f) => f.path === `${FILES}/b` && f.status === 'removed' && f.size_a === 8));
		},
	},
	{
		name: 'rename a directory without editing its child',
		before: async (fs) => { await fs.dir('Old'); await fs.write('Old/f', 'original'); },
		after: async (fs) => { await fs.move('Old', 'New'); },
		checkEvents: (events) => {
			assert.ok(events.some((e) => e.changeType === 'renamed' && e.path === `${FILES}/Old`));
			assert.ok(!events.some((e) => e.path.endsWith('/f')), 'An untouched child has no event just because its parent moved');
		},
	},
	{
		name: 'rename a directory and edit a child',
		before: async (fs) => { await fs.dir('Old'); await fs.write('Old/f', 'original'); await fs.write('Old/g', 'same'); },
		after: async (fs) => { await fs.move('Old', 'New'); await fs.write('New/f', 'changed'); },
	},
	{
		name: 'rename a directory and add a file to it',
		before: async (fs) => { await fs.dir('Old'); await fs.write('Old/f', 'original'); },
		after: async (fs) => { await fs.move('Old', 'New'); await fs.write('New/added', 'new'); },
	},
	{
		name: 'rename a directory and a child inside it',
		before: async (fs) => { await fs.dir('Old'); await fs.write('Old/f', 'original'); },
		after: async (fs) => { await fs.move('Old', 'New'); await fs.move('New/f', 'New/g'); },
	},
	{
		name: 'rename a directory and a subdirectory inside it',
		before: async (fs) => { await fs.dir('Old'); await fs.dir('Old/sub'); await fs.write('Old/sub/f', 'original'); },
		after: async (fs) => { await fs.move('Old', 'New'); await fs.move('New/sub', 'New/sub2'); },
	},
	{
		name: 'delete a child and rename its parent',
		before: async (fs) => { await fs.dir('Old'); await fs.write('Old/f', 'original'); },
		after: async (fs) => { await fs.remove('Old/f'); await fs.move('Old', 'New'); },
	},
	{
		name: 'delete a subdirectory and rename its parent',
		before: async (fs) => { await fs.dir('Old'); await fs.dir('Old/sub'); await fs.write('Old/sub/f', 'original'); await fs.write('Old/k', 'kept'); },
		after: async (fs) => { await fs.remove('Old/sub/f'); await fs.rmdir('Old/sub'); await fs.move('Old', 'New'); },
	},
	{
		name: 'replace a child of a renamed directory with a new file of the same name',
		before: async (fs) => { await fs.dir('Old'); await fs.write('Old/f', 'original'); },
		after: async (fs) => { await fs.move('Old', 'New'); await fs.remove('New/f'); await fs.write('New/f', 'new'); },
	},
	{
		name: 'rename a directory onto the name of a directory that was removed',
		before: async (fs) => { await fs.dir('A'); await fs.write('A/x', 'xx'); await fs.dir('B'); await fs.write('B/y', 'yyy'); },
		after: async (fs) => { await fs.remove('B/y'); await fs.rmdir('B'); await fs.move('A', 'B'); },
	},
	{
		name: 'rename a directory onto the name of a directory that was moved away',
		before: async (fs) => { await fs.dir('A'); await fs.write('A/x', 'xx'); await fs.dir('B'); await fs.write('B/y', 'yyy'); },
		after: async (fs) => { await fs.move('B', 'C'); await fs.move('A', 'B'); },
	},
	{
		name: 'shift two directories and change their children',
		before: async (fs) => { await fs.dir('A'); await fs.write('A/x', 'xx'); await fs.dir('B'); await fs.write('B/y', 'yyy'); await fs.write('B/z', 'zzzz'); },
		after: async (fs) => { await fs.move('B', 'C'); await fs.move('A', 'B'); await fs.remove('C/z'); await fs.write('B/x', 'changed'); await fs.write('C/y', 'changed too'); },
	},
	{
		name: 'move a directory into a directory that took over another name',
		before: async (fs) => { await fs.dir('A'); await fs.write('A/x', 'xx'); await fs.dir('B'); await fs.write('B/y', 'yyy'); await fs.dir('Q'); await fs.write('Q/q', 'q'); },
		after: async (fs) => { await fs.move('B', 'C'); await fs.move('A', 'B'); await fs.move('Q', 'B/sub'); },
	},
	{
		name: 'rename two directories and edit a child created after its parent',
		before: async (fs) => {
			await fs.dir('One');
			await fs.write('One/f', 'aaaaa');
			await fs.dir('Two');
			await fs.write('Two/f', 'bbbbbbbb');
		},
		after: async (fs) => {
			await fs.move('Two', 'Three');
			await fs.move('One', 'Two');
			await fs.write('Two/f', 'new');
		},
	},
	{
		name: 'rename two directories and edit a child older than its parent',
		before: async (fs) => {
			// A pre-existing document is filed into a newer directory before S1.
			await fs.write('document', 'aaaaa');
			await fs.dir('One');
			await fs.move('document', 'One/f');
			await fs.dir('Two');
			await fs.write('Two/f', 'bbbbbbbb');
		},
		after: async (fs) => {
			await fs.move('Two', 'Three');
			await fs.move('One', 'Two');
			await fs.write('Two/f', 'new');
		},
		checkEvents: (events) => {
			assert.ok(events.some((e) => e.changeType === 'renamed' && e.path === `${FILES}/One/f` && e.newPath === `${FILES}/Two/f`));
			assert.ok(!events.some((e) => e.changeType === 'modified' && e.path === `${FILES}/Two/f`));
		},
	},
	{
		name: 'shift two directories that both hold the same subdirectory and file names',
		before: async (fs) => {
			await fs.dir('One'); await fs.dir('One/s'); await fs.write('One/s/f', 'aaaaa');
			await fs.dir('Two'); await fs.dir('Two/s'); await fs.write('Two/s/f', 'bbbbbbbb'); await fs.write('Two/s/g', 'gg');
		},
		after: async (fs) => {
			await fs.move('Two', 'Three');
			await fs.move('One', 'Two');
			await fs.write('Two/s/f', 'new');
			await fs.write('Three/s/g', 'changed');
		},
	},
	{
		name: 'import an existing directory from outside the indexed scope',
		before: async (fs) => { await fs.dir('/staging'); await fs.write('/staging/f', 'original'); },
		after: async (fs) => { await fs.move('/staging', 'Imported'); },
	},
	{
		name: 'import a nested directory from outside the indexed scope',
		before: async (fs) => { await fs.dir('/staging'); await fs.dir('/staging/sub'); await fs.dir('/staging/empty'); await fs.write('/staging/f', 'one'); await fs.write('/staging/sub/g', 'two'); },
		after: async (fs) => { await fs.move('/staging', 'Imported'); },
	},
	{
		name: 'move a directory out of the indexed scope',
		before: async (fs) => { await fs.dir('/outside'); await fs.dir('Leaving'); await fs.dir('Leaving/sub'); await fs.write('Leaving/f', 'one'); await fs.write('Leaving/sub/g', 'two'); await fs.write('stays', 's'); },
		after: async (fs) => { await fs.move('Leaving', '/outside/Leaving'); },
	},
	{
		name: 'move a file to the trash',
		before: async (fs) => { await fs.dir('/data/user/files_trashbin'); await fs.dir(TRASH); await fs.write('report', 'contents'); },
		after: async (fs) => { await fs.move('report', `${TRASH}/report.d1776185835`); },
		check: (db) => {
			const entry = since(db, 's1', { json: true, path: FILES, summary: true }).entries.find((e) => e.name === 'report');
			assert.deepEqual(entry?.states, ['deleted'], 'A file that sits in the trash is deleted, not moved');
		},
	},
	{
		name: 'replace a file with a directory',
		before: async (fs) => { await fs.write('entry', 'old contents'); },
		after: async (fs) => { await fs.remove('entry'); await fs.dir('entry'); },
		check: (db) => {
			const summary = since(db, 's1', { json: true, path: FILES, summary: true });
			const entry = summary.entries.find((e) => e.name === 'entry');
			assert.deepEqual(entry?.states, ['deleted'], 'The old file is deleted; the new directory has a separate history');
			const rows = db.prepare(`SELECT f.id, f.type, f.deleted_at_snap_id, v.snapshot_id
				FROM files f JOIN file_versions v ON v.file_id = f.id
				WHERE COALESCE(f.overwritten_from, f.path) = ? ORDER BY v.snapshot_id`).all(`${FILES}/entry`);
			assert.equal(rows.length, 2);
			assert.notEqual(rows[0].id, rows[1].id, 'A file and a directory must not share a history');
			assert.deepEqual(rows.map(({ type, deleted_at_snap_id, snapshot_id }) => ({ type, deleted_at_snap_id, snapshot_id })), [
				{ type: 'file', deleted_at_snap_id: 2, snapshot_id: 1 },
				{ type: 'dir', deleted_at_snap_id: null, snapshot_id: 2 },
			]);
		},
	},
	{
		name: 'replace a directory with a file',
		before: async (fs) => { await fs.dir('entry'); await fs.write('entry/x', 'inside'); },
		after: async (fs) => { await fs.remove('entry/x'); await fs.rmdir('entry'); await fs.write('entry', 'now a file'); },
	},
];

const objectKey = (entry) => { return `${entry.stat.ino}:${entry.stat.birthtimeNs}`; };

function assertIndexMatchesFilesystem(db, f) {
	const live = db.prepare(`SELECT f.id, f.path, f.type, f.inode,
		(SELECT size FROM file_versions WHERE file_id=f.id ORDER BY snapshot_id DESC LIMIT 1) AS size
		FROM files f WHERE deleted_at_snap_id IS NULL ORDER BY path`).all().map((r) => ({ ...r }));
	const inScope = (entries) => { return [...entries.values()].filter((e) => isInScope(e.path, e.type === 'dir')); };
	const expected = inScope(f.after)
		.map((e) => ({ path: e.path, type: e.type, inode: Number(e.stat.ino), size: e.size }))
		.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	assert.deepEqual(live.map(({ id, ...row }) => row), expected, 'Live index must agree with the actual final filesystem');

	for (const v of db.prepare('SELECT snapshot_id, path, size FROM file_versions').all()) {
		const entry = (v.snapshot_id === 1 ? f.before : f.after).get(v.path);
		assert.ok(entry, `Version points at a nonexistent snapshot path: ${v.path}`);
		assert.equal(v.size, entry.size, `Version size disagrees with snapshot: ${v.path}`);
	}
	assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM files WHERE path LIKE '#%'`).get().n, 0, 'Nothing may be left set aside after a snapshot');
}

function assertHistoriesFollowObjects(db, f) {
	const before = new Map([...f.before.values()].map((e) => [objectKey(e), e]));
	const after = new Map([...f.after.values()].map((e) => [objectKey(e), e]));
	const firstVersion = db.prepare(`SELECT v.path FROM file_versions v WHERE v.file_id = ? AND v.snapshot_id = 1`);
	const liveAt = db.prepare(`SELECT id, type FROM files WHERE path = ? AND deleted_at_snap_id IS NULL`);

	for (const entry of f.after.values()) {
		if (!isInScope(entry.path, entry.type === 'dir')) {
			continue;
		}
		const row = liveAt.get(entry.path);
		const origin = before.get(objectKey(entry));
		const began = firstVersion.get(row.id)?.path ?? null;
		if (origin && isInScope(origin.path, origin.type === 'dir')) {
			assert.equal(began, origin.path, `${entry.path} must carry the history of the object that was ${origin.path}`);
		} else if (began !== null) {
			assert.equal(began, entry.path, `${entry.path} is a new object and may only continue a history of its own name`);
			assert.equal(f.before.get(entry.path)?.type, entry.type, `${entry.path} must not continue the history of another kind of entry`);
		}
	}

	for (const entry of f.before.values()) {
		if (!isInScope(entry.path, entry.type === 'dir')) {
			continue;
		}
		const survivor = after.get(objectKey(entry));
		const replacement = f.after.get(entry.path);
		if ((survivor && isInScope(survivor.path, survivor.type === 'dir')) || (replacement && replacement.type === entry.type && !before.has(objectKey(replacement)))) {
			continue;
		}
		const gone = db.prepare(`SELECT COUNT(*) AS n FROM files f JOIN file_versions v ON v.file_id = f.id AND v.snapshot_id = 1
			WHERE f.deleted_at_snap_id IS NOT NULL AND v.path = ?`).get(entry.path).n;
		assert.equal(gone, 1, `${entry.path} no longer exists and must be kept as exactly one deleted entry`);
	}
}

for (const scenario of scenarios) {
	test(scenario.name, async (t) => {
		const f = await fixture(t, scenario);
		const orders = eventOrders(f.events);
		for (const handler of [flushUnifiedBatch, flushIncrementalBatch]) {
			for (const batchSize of [Number.MAX_SAFE_INTEGER, 1]) {
				await t.test(`${handler.name}, ${batchSize === 1 ? 'split batches' : 'one batch'}, ${orders.length} event order${orders.length === 1 ? '' : 's'}`, async () => {
					for (const events of orders) {
						const label = `events in order ${JSON.stringify(events.map((e) => [e.changeType, e.path.slice(FILES.length), e.newPath?.slice(FILES.length) ?? null]))}`;
						const db = database.open(':memory:');
						try {
							const stmt = seed(db, f.before), context = createSnapshotContext();
							const snap = { id: 2, name: 's2', created_at: 200 };
							const perf = performanceCounters();
							await database.atomic(db, async () => {
								for (let i = 0; i < events.length; i += batchSize) await handler(db, stmt, perf, events.slice(i, i + batchSize), snap, 1, null, f.snapPath, context);
								finishSnapshot(db, stmt, perf, snap, 1, context);
								stmt.markIndexed.run(1, 2);
								if (handler === flushUnifiedBatch) stmt.markDiffDone.run(2);
							});
							stmt.bumpLastSeen.run(2, 1);
							assert.equal(perf.orphanedChanges, 0, 'No change should lose its source row');
							assertIndexMatchesFilesystem(db, f);
							assertHistoriesFollowObjects(db, f);
							if (handler === flushUnifiedBatch) scenario.check?.(db);
						} catch (error) {
							error.message = `${error.message}\n${label}`;
							throw error;
						} finally { db.close(); }
					}
				});
			}
		}
	});
}
