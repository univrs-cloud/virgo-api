import assert from 'node:assert/strict';
import test from 'node:test';
import * as database from '../indexer/db.js';
import { diff, history, search, since, deleted } from '../indexer/query.js';
import { FILES, timeline } from './helpers/indexer-fixture.js';

test('search pages combine token and substring matches without repeats or omissions', async (t) => {
	const { db } = await timeline(t, async (fs) => {
		await fs.write('annualreport.txt', 'annual');
		await fs.write('report.txt', 'report');
		await fs.write('report-final.txt', 'final');
		await fs.write('unrelated.txt', 'unrelated');
	});
	database.disableBulkMode(db); // Exercise real FTS, not just the LIKE fallback.
	const all = search(db, 'report', { json: true }).map((r) => r.path);
	assert.deepEqual(all, [`${FILES}/annualreport.txt`, `${FILES}/report-final.txt`, `${FILES}/report.txt`]);
	const pages = [0, 1, 2, 3].flatMap((offset) => search(db, 'report', { json: true, limit: 1, offset }).map((r) => r.path));
	assert.deepEqual(pages, all);
});

test('search size filters use the latest version when the newest snapshot is unchanged', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.write('report', 'old'); });
	await x.step(async (fs) => { await fs.write('report', '0123456789'); });
	await x.step();
	database.disableBulkMode(x.db);
	assert.equal(search(x.db, 'report', { json: true, minSize: 9, maxSize: 11 })[0]?.size, 10);
	assert.deepEqual(search(x.db, 'report', { json: true, maxSize: 9 }), []);
});

test('search live and deleted filters distinguish a removed file', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.write('report', 'old'); });
	await x.step(async (fs) => { await fs.remove('report'); });
	database.disableBulkMode(x.db);
	assert.deepEqual(search(x.db, 'report', { json: true, state: 'live' }), []);
	assert.equal(search(x.db, 'report', { json: true, state: 'deleted' })[0]?.deleted, 1);
});

test('history finds an unchanged child by its original name after its parent moves', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.dir('Old'); await fs.write('Old/f', 'old'); });
	await x.step(async (fs) => { await fs.move('Old', 'New'); });
	const result = history(x.db, `${FILES}/Old/f`, { json: true });
	assert.equal(result.versions.length, 1);
	assert.equal(result.versions[0].size, 3);
	assert.ok(result.versions[0].snapshot_path.endsWith(`/s1${FILES}/Old/f`));
});

test('reusing a deleted folder name keeps both files recoverable in history', async (t) => {
	const x = await timeline(t, async (fs) => {
		await fs.dir('Old'); await fs.write('Old/f', 'aaaaa');
		await fs.dir('Dest'); await fs.write('Dest/f', 'bbbbbbbb');
	});
	await x.step(async (fs) => { await fs.remove('Dest/f'); await fs.rmdir('Dest'); });
	await x.step(async (fs) => { await fs.move('Old', 'Dest'); });
	const result = history(x.db, `${FILES}/Dest/f`, { json: true });
	assert.deepEqual(result.versions.map((v) => v.size).sort((a, b) => a - b), [5, 8]);
	assert.deepEqual(result.versions.map((v) => v.snapshot_path).sort(), [
		`/fixture/.zfs/snapshot/s1${FILES}/Dest/f`, `/fixture/.zfs/snapshot/s1${FILES}/Old/f`,
	]);
	assert.ok(deleted(x.db, { json: true }).deleted.some((f) => f.size === 8 && f.snapshot_path.endsWith(`${FILES}/Dest/f`)));
});

test('diff reports the old and new sizes of a delete-and-recreate replacement', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.write('f', '0123456789'); });
	await x.step(async (fs) => { await fs.remove('f'); await fs.write('f', 'short'); });
	const files = diff(x.db, 's1', 's2', { json: true }).files.filter((f) => f.path === `${FILES}/f`);
	assert.deepEqual(files, [{ path: `${FILES}/f`, size_a: 10, size_b: 5, delta: -5, status: 'modified' }]);
});

test('diff of a historical interval excludes later file renames', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.write('a', 'old'); });
	await x.step(async (fs) => { await fs.write('a', 'changed'); });
	await x.step(async (fs) => { await fs.move('a', 'b'); });
	assert.deepEqual(diff(x.db, 's1', 's2', { json: true }).files, [
		{ path: `${FILES}/a`, size_a: 3, size_b: 7, delta: 4, status: 'modified' },
	]);
});

test('diff keeps a deleted child at its deletion path through a later parent rename', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.dir('Old'); await fs.write('Old/f', 'old'); });
	await x.step(async (fs) => { await fs.remove('Old/f'); });
	await x.step(async (fs) => { await fs.move('Old', 'New'); });
	assert.deepEqual(diff(x.db, 's1', 's3', { json: true }).files.filter((f) => f.status === 'removed'), [
		{ path: `${FILES}/Old/f`, size_a: 3, size_b: null, delta: -3, status: 'removed' },
	]);
});

test('diff excludes files created and removed entirely inside the selected interval', async (t) => {
	const x = await timeline(t, async () => {});
	await x.step(async (fs) => { await fs.write('temporary', 'temp'); });
	await x.step(async (fs) => { await fs.remove('temporary'); });
	assert.ok(!diff(x.db, 's1', 's3', { json: true }).files.some((f) => f.path === `${FILES}/temporary`));
});

test('since reports same-name replacements as modified', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.write('f', 'old'); });
	await x.step(async (fs) => { await fs.remove('f'); await fs.write('f', 'new content'); });
	assert.deepEqual(since(x.db, 's1', { json: true, path: FILES }).files, [
		{ path: `${FILES}/f`, type: 'file', states: ['modified'], current_path: null },
	]);
});

test('since reconstructs the original folder of a file modified after its parent moved', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.dir('Old'); await fs.write('Old/f', 'old'); });
	await x.step(async (fs) => { await fs.move('Old', 'New'); });
	await x.step(async (fs) => { await fs.write('New/f', 'new content'); });
	assert.deepEqual(since(x.db, 's1', { json: true, path: `${FILES}/Old` }).files, [
		{ path: `${FILES}/Old/f`, type: 'file', states: ['modified'], current_path: `${FILES}/New/f` },
	]);
});

test('an unchanged snapshot produces no diff or browser changes', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.write('f', 'old'); });
	await x.step();
	assert.equal(diff(x.db, 's1', 's2', { json: true }).total, 0);
	assert.deepEqual(since(x.db, 's1', { json: true, path: FILES, summary: true }).entries, []);
});

test('search finds a term inside a word and across separators', async (t) => {
	const { db } = await timeline(t, async (fs) => {
		await fs.write('invoice.pdf', 'invoice');
		await fs.write('budget_2026.xlsx', 'budget');
		await fs.write('other.txt', 'other');
	});
	database.disableBulkMode(db);
	assert.deepEqual(search(db, 'voice', { json: true }).map((r) => r.path), [`${FILES}/invoice.pdf`]);
	assert.deepEqual(search(db, 'budget 2026', { json: true }).map((r) => r.path), [`${FILES}/budget_2026.xlsx`]);
	assert.deepEqual(search(db, 'nothing-like-this', { json: true }), []);
});

test('history finds a renamed file by its old and its new name', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.write('old', 'old'); });
	await x.step(async (fs) => { await fs.move('old', 'new'); await fs.write('new', 'changed'); });
	for (const name of ['old', 'new']) {
		const result = history(x.db, `${FILES}/${name}`, { json: true });
		assert.deepEqual(result.versions.map((v) => [v.snapshot, v.version_path, v.size]), [['s1', `${FILES}/old`, 3], ['s2', `${FILES}/new`, 7]]);
		assert.deepEqual(result.changes.map((c) => c.change_type), ['renamed']);
	}
});

test('history of a path lists both the file that was overwritten there and the one that replaced it', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.write('a', 'aaaaa'); await fs.write('b', 'bbbbbbbb'); });
	await x.step(async (fs) => { await fs.move('a', 'b'); });
	const result = history(x.db, `${FILES}/b`, { json: true });
	assert.deepEqual(result.versions.map((v) => [v.snapshot, v.version_path, v.size]).sort(), [['s1', `${FILES}/a`, 5], ['s1', `${FILES}/b`, 8], ['s2', `${FILES}/b`, 5]]);
});

test('diff follows a live file through a later folder rename inside the interval', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.dir('Old'); await fs.write('Old/f', 'old'); });
	await x.step(async (fs) => { await fs.write('Old/f', 'changed'); });
	await x.step(async (fs) => { await fs.move('Old', 'New'); });
	assert.ok(diff(x.db, 's1', 's2', { json: true }).files.some((f) => f.path === `${FILES}/Old/f` && f.status === 'modified'));
	assert.ok(diff(x.db, 's1', 's3', { json: true }).files.some((f) => f.path === `${FILES}/New/f` && f.status === 'modified'));
});

test('since keeps a deleted child in its snapshot folder after the folder is renamed', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.dir('Old'); await fs.write('Old/gone', 'gone'); await fs.write('Old/kept', 'kept'); });
	await x.step(async (fs) => { await fs.remove('Old/gone'); });
	await x.step(async (fs) => { await fs.move('Old', 'New'); });
	const folder = since(x.db, 's1', { json: true, path: `${FILES}/Old`, summary: true });
	assert.equal(folder.moved_to, `${FILES}/New`);
	assert.deepEqual(folder.entries.map((e) => [e.name, e.states]), [['gone', ['deleted']]]);
	const parent = since(x.db, 's1', { json: true, path: FILES, summary: true }).entries.find((e) => e.name === 'Old');
	assert.deepEqual([parent.states, parent.current_path, parent.inside], [['renamed'], `${FILES}/New`, 1]);
	assert.deepEqual(since(x.db, 's1', { json: true, path: `${FILES}/New`, summary: true }).entries, []);
});

test('since reports a file that another file was renamed over as modified, and the other as renamed', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.write('a', 'aaaaa'); await fs.write('b', 'bbbbbbbb'); });
	await x.step(async (fs) => { await fs.move('a', 'b'); });
	const files = since(x.db, 's1', { json: true, path: FILES }).files.map((f) => [f.path, f.states, f.current_path]);
	assert.deepEqual(files, [[`${FILES}/a`, ['renamed'], `${FILES}/b`], [`${FILES}/b`, ['modified'], null]]);
});

test('since tells moved from renamed and filters by state', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.dir('In'); await fs.write('moved', 'm'); await fs.write('renamed', 'r'); await fs.write('gone', 'g'); await fs.write('same', 's'); });
	await x.step(async (fs) => { await fs.move('moved', 'In/moved'); await fs.move('renamed', 'named'); await fs.remove('gone'); });
	const states = (options) => since(x.db, 's1', { json: true, path: FILES, ...options }).files.map((f) => [f.path.slice(FILES.length + 1), f.states]);
	assert.deepEqual(states({}), [['gone', ['deleted']], ['moved', ['moved']], ['renamed', ['renamed']]]);
	assert.deepEqual(states({ state: 'moved,deleted' }), [['gone', ['deleted']], ['moved', ['moved']]]);
});

test('since counts changes inside a folder by state', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.dir('Docs'); await fs.dir('Docs/deep'); await fs.write('Docs/a', 'a'); await fs.write('Docs/deep/b', 'b'); await fs.write('Docs/deep/c', 'c'); });
	await x.step(async (fs) => { await fs.write('Docs/a', 'changed'); await fs.remove('Docs/deep/b'); await fs.remove('Docs/deep/c'); });
	const docs = since(x.db, 's1', { json: true, path: FILES, summary: true }).entries.find((e) => e.name === 'Docs');
	assert.equal(docs.inside, 3);
	assert.deepEqual(docs.inside_groups.map((g) => [g.states, g.count]).sort(), [[['deleted'], 2], [['modified'], 1]]);
});

test('since answers for an indexed snapshot only', async (t) => {
	const x = await timeline(t, async (fs) => { await fs.write('f', 'old'); });
	assert.deepEqual(since(x.db, 'not-a-snapshot', { json: true, path: FILES }), { indexed: false });
	assert.equal(since(x.db, 's1', { json: true, path: FILES }).indexed, true);
});
