import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as database from '../indexer/db.js';
import { fixture, seed, writeTransition, databaseContents, FILES } from './helpers/indexer-fixture.js';

const overwrite = {
	before: async (fs) => { await fs.write('a', 'aaaaa'); await fs.write('b', 'bbbbbbbb'); },
	after: async (fs) => { await fs.move('a', 'b'); },
};

for (const phase of ['after a rename batch', 'after finalization and completion markers']) {
	test(`a snapshot failure ${phase} restores the entire pre-snapshot index`, async (t) => {
		const f = await fixture(t, overwrite), db = database.open(':memory:');
		try {
			const stmt = seed(db, f.before), before = databaseContents(db);
			const error = new Error('Injected failure');
			const options = phase === 'after a rename batch' ? {
				afterBatch: (index) => { if (f.events[index].changeType === 'renamed') throw error; },
			} : { afterFinish: () => { throw error; } };
			await assert.rejects(database.atomic(db, () => writeTransition(db, stmt, f, options)), (e) => e === error);
			assert.deepEqual(databaseContents(db), before, 'Rows, versions, changes and completion markers must all roll back');
		} finally { db.close(); }
	});
}

test('retrying a failed snapshot produces exactly the same index as a clean run', async (t) => {
	const f = await fixture(t, overwrite);
	const retried = database.open(':memory:'), clean = database.open(':memory:');
	try {
		const stmt = seed(retried, f.before), cleanStmt = seed(clean, f.before);
		await assert.rejects(database.atomic(retried, () => writeTransition(retried, stmt, f, {
			afterFinish: () => { throw new Error('Injected failure'); },
		})), /Injected failure/);
		await database.atomic(retried, () => writeTransition(retried, stmt, f));
		await database.atomic(clean, () => writeTransition(clean, cleanStmt, f));
		assert.deepEqual(databaseContents(retried), databaseContents(clean));
		const live = retried.prepare("SELECT path FROM files WHERE type='file' AND deleted_at_snap_id IS NULL").all();
		assert.deepEqual(live.map((r) => r.path), [`${FILES}/b`]);
	} finally { retried.close(); clean.close(); }
});

test('a separate reader sees only complete snapshots while the writer awaits commit', async (t) => {
	const f = await fixture(t, overwrite);
	const dir = await mkdtemp(join(tmpdir(), 'virgo-indexer-reader-'));
	const path = join(dir, 'index.db');
	const writer = database.open(path);
	let reader;
	try {
		const stmt = seed(writer, f.before), before = databaseContents(writer);
		await database.atomic(writer, () => writeTransition(writer, stmt, f, {
			afterFinish: async () => {
				// Opening a query connection during a write must also be safe.
				reader = database.open(path);
				assert.deepEqual(databaseContents(reader), before);
				await Promise.resolve();
				assert.deepEqual(databaseContents(reader), before);
			},
		}));
		assert.deepEqual(databaseContents(reader), databaseContents(writer));
		assert.equal(reader.prepare('SELECT diff_done FROM snapshots WHERE id=2').get().diff_done, 1);
	} finally {
		reader?.close(); writer.close();
		await rm(dir, { recursive: true, force: true });
	}
});
