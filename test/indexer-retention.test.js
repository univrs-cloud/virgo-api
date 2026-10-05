import assert from 'node:assert/strict';
import test from 'node:test';
import { pruneDeletedSnapshots, pruneVanishedSnapshots } from '../indexer/index.js';
import { FILES, DATASET, timeline } from './helpers/indexer-fixture.js';

function prune(x, live) {
	return pruneDeletedSnapshots(x.db, x.stmt, [{ name: DATASET }], { [DATASET]: 1 }, new Set(live.map((id) => `${DATASET}@s${id}`)));
}

function versions(x, path = `${FILES}/f`) {
	return x.db.prepare(`SELECT v.snapshot_id, v.path, v.size FROM file_versions v
		JOIN files f ON f.id=v.file_id WHERE f.path=? ORDER BY v.snapshot_id`).all(path).map((r) => ({ ...r }));
}

test('retention carries the newest expired version through consecutive pruned snapshots', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.write('f', 'old'); });
	await x.step(async (fs) => { await fs.write('f', 'new content'); });
	await x.step();
	assert.equal(prune(x, [3]), 2);
	assert.deepEqual(versions(x), [{ snapshot_id: 3, path: `${FILES}/f`, size: 11 }]);
	assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n, 1);
});

for (const order of [[1, 2], [2, 1]]) {
	test(`mid-run pruning preserves the newest version when disappearance order is ${order}`, async (t) => {
		const x = await timeline(t, async (fs) => { await fs.write('f', 'old'); });
		await x.step(async (fs) => { await fs.write('f', 'new content'); });
		await x.step();
		const perf = { vanishedList: order.map((id) => ({ fullName: `${DATASET}@s${id}`, datasetId: 1 })) };
		assert.equal(pruneVanishedSnapshots(x.db, x.stmt, perf), 2);
		assert.deepEqual(versions(x), [{ snapshot_id: 3, path: `${FILES}/f`, size: 11 }]);
		assert.deepEqual(perf.vanishedList, []);
	});
}

test('retention reanchors an unchanged file instead of orphaning it', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.write('f', 'unchanged'); });
	await x.step();
	prune(x, [2]);
	assert.deepEqual(versions(x), [{ snapshot_id: 2, path: `${FILES}/f`, size: 9 }]);
	assert.equal(x.stmt.deleteOrphanedFiles.run().changes, 0);
});

test('retention advances the recovery path of an unchanged child through a folder rename', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.dir('Old'); await fs.write('Old/f', 'old'); });
	await x.step(async (fs) => { await fs.move('Old', 'New'); });
	prune(x, [2]);
	assert.deepEqual(versions(x, `${FILES}/New/f`), [{ snapshot_id: 2, path: `${FILES}/New/f`, size: 3 }]);
	assert.ok(x.captures.get(2).has(versions(x, `${FILES}/New/f`)[0].path));
});

test('retention does not invent a version during a deletion gap before recreation', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.write('f', 'old'); });
	await x.step(async (fs) => { await fs.remove('f'); });
	await x.step(async (fs) => { await fs.write('f', 'new content'); });
	prune(x, [2, 3]);
	assert.deepEqual(versions(x), [{ snapshot_id: 3, path: `${FILES}/f`, size: 11 }]);
	assert.ok(!x.captures.get(2).has(`${FILES}/f`));
});

test('retention removes an unrecoverable deleted file when its last version expires', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.write('f', 'old'); });
	await x.step(async (fs) => { await fs.remove('f'); });
	prune(x, [2]);
	x.stmt.deleteChangesForOrphanedFiles.run();
	x.stmt.deleteOrphanedFiles.run();
	assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM files WHERE path=?').get(`${FILES}/f`).n, 0);
});

test('pruning the deletion snapshot preserves a tombstone while its old version survives', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.write('f', 'old'); });
	await x.step(async (fs) => { await fs.remove('f'); });
	await x.step();
	prune(x, [1, 3]);
	assert.equal(x.db.prepare('SELECT deleted_at_snap_id FROM files WHERE path=?').get(`${FILES}/f`).deleted_at_snap_id, 3);
	assert.deepEqual(versions(x), [{ snapshot_id: 1, path: `${FILES}/f`, size: 3 }]);
});

test('retention carries the newest version through three pruned snapshots in a row', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.write('f', 'a'); await fs.write('still', 'unchanged'); });
	await x.step(async (fs) => { await fs.write('f', 'bb'); });
	await x.step(async (fs) => { await fs.write('f', 'ccc'); });
	await x.step();
	assert.equal(prune(x, [4]), 3);
	assert.deepEqual(versions(x), [{ snapshot_id: 4, path: `${FILES}/f`, size: 3 }]);
	assert.deepEqual(versions(x, `${FILES}/still`), [{ snapshot_id: 4, path: `${FILES}/still`, size: 9 }]);
});

test('retention keeps the versions on both sides of a pruned gap', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.write('f', 'a'); });
	await x.step(async (fs) => { await fs.write('f', 'bb'); });
	await x.step(async (fs) => { await fs.write('f', 'ccc'); });
	await x.step();
	assert.equal(prune(x, [1, 4]), 2);
	assert.deepEqual(versions(x), [{ snapshot_id: 1, path: `${FILES}/f`, size: 1 }, { snapshot_id: 4, path: `${FILES}/f`, size: 3 }]);
});

test('retention leaves a surviving snapshot its own version', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.write('f', 'a'); });
	await x.step(async (fs) => { await fs.write('f', 'bb'); });
	await x.step(async (fs) => { await fs.write('f', 'ccc'); });
	assert.equal(prune(x, [3]), 2);
	assert.deepEqual(versions(x), [{ snapshot_id: 3, path: `${FILES}/f`, size: 3 }]);
});
