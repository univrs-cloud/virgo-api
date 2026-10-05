import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import * as database from '../../indexer/db.js';
import { prepareIndexerStatements } from '../../indexer/index.js';
import { createSnapshotContext, finishSnapshot, flushUnifiedBatch } from '../../indexer/flush.js';
import { isInScope } from '../../indexer/scope.js';
import { scopeDiffEntry } from '../../indexer/zfs.js';

export const FILES = '/data/user/files';
export const DATASET = 'messier/apps/nextcloud';
const zfsParent = process.env.VIRGO_INDEXER_ZFS_TEST_PARENT;
const zfs = (...args) => execFileSync('zfs', args, { encoding: 'utf8' }).trim();

async function capture(root) {
	const entries = new Map();
	async function visit(path) {
		const stat = await lstat(root + path, { bigint: true });
		const type = stat.isDirectory() ? 'dir' : 'file';
		assert.ok(stat.isDirectory() || stat.isFile(), 'These scenarios support ordinary files and directories only');
		if (type === 'file') assert.equal(stat.nlink, 1n, 'Hard-link event semantics are outside this model');
		entries.set(path, { path, type, stat, size: type === 'dir' ? 0 : Number(stat.size) });
		if (type === 'dir') for (const name of await readdir(root + path)) await visit(`${path}/${name}`);
	}
	for (const name of await readdir(root)) if (name !== '.zfs') await visit(`/${name}`);
	return entries;
}

// Ordinary-file subset of OpenZFS write_inuse_diffs_one, pinned to the release the nodes run:
// https://github.com/openzfs/zfs/blob/zfs-2.4.4/lib/libzfs/libzfs_diff.c#L263-L363
// A rename changes the moved object's own ctime and its parents' (zfs_link_create):
// https://github.com/openzfs/zfs/blob/zfs-2.4.4/module/os/linux/zfs/zfs_dir.c
// Same object + unchanged ctime: no event (including untouched moved children).
// Same object + changed ctime: R when paths differ, M otherwise.
// Distinct objects: removal/addition. Include directory metadata changes too.
// zfs diff prints in object-number order, which says nothing about what happened first.
// Local inode order stands in for it here, and `eventOrders` supplies the other orders.
// The opt-in ZFS backend uses actual output instead of this model.
function modelEvents(before, after) {
	const byInode = (entries) => new Map([...entries.values()].map((e) => [e.stat.ino, e]));
	const oldObjects = byInode(before), newObjects = byInode(after);
	assert.equal(oldObjects.size, before.size);
	assert.equal(newObjects.size, after.size);
	const inodes = [...new Set([...oldObjects.keys(), ...newObjects.keys()])].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
	const events = [];
	const emit = (changeType, old, current = null) => events.push({
		changeType, path: old.path, newPath: current?.path ?? null,
		fileType: (current ?? old).type, changedAt: Number((current ?? old).stat.ctimeNs / 1000000000n),
	});
	for (const ino of inodes) {
		const old = oldObjects.get(ino), current = newObjects.get(ino);
		if (!old) emit('added', current);
		else if (!current) emit('removed', old);
		else if (old.type !== current.type || old.stat.birthtimeNs !== current.stat.birthtimeNs) {
			emit('removed', old); emit('added', current);
		} else if (old.stat.ctimeNs !== current.stat.ctimeNs) {
			if (old.path === current.path) emit('modified', current);
			else emit('renamed', old, current);
		}
	}
	return events;
}

function parseZfsOutput(output, mountpoint) {
	return output.split('\n').filter(Boolean).map((line) => {
		const [time, code, type, path, newPath] = line.split('\t');
		assert.ok(['+', '-', 'M', 'R'].includes(code), line);
		assert.ok(['F', '/'].includes(type), line);
		// Fixtures deliberately use plain ASCII names without whitespace/escapes.
		assert.ok(path.startsWith(`${mountpoint}/`), line);
		if (code === 'R') assert.ok(newPath?.startsWith(`${mountpoint}/`), line);
		return {
			changeType: { '+': 'added', '-': 'removed', M: 'modified', R: 'renamed' }[code],
			fileType: type === '/' ? 'dir' : 'file', path: path.slice(mountpoint.length),
			newPath: code === 'R' ? newPath.slice(mountpoint.length) : null, changedAt: Math.floor(Number(time)),
		};
	});
}

async function workspace(t) {
	const temp = await mkdtemp(join(tmpdir(), 'virgo-indexer-scenario-'));
	let dataset;
	// Register cleanup before creating anything; never destroy the supplied parent.
	t.after(async () => {
		if (dataset) zfs('destroy', '-r', dataset);
		await rm(temp, { recursive: true, force: true });
	});
	const root = join(temp, 'mount');
	await mkdir(root);
	if (zfsParent) {
		const child = `${zfsParent}/virgo-review-${process.pid}-${temp.split('-').at(-1)}`;
		zfs('create', '-o', `mountpoint=${root}`, '-o', 'atime=off', child);
		dataset = child;
	}
	await mkdir(root + FILES, { recursive: true });
	const path = (p) => root + (p.startsWith('/') ? p : `${FILES}/${p}`);
	const fs = {
		write: (p, content) => writeFile(path(p), content),
		dir: (p) => mkdir(path(p)),
		move: (a, b) => rename(path(a), path(b)),
		remove: (p) => unlink(path(p)),
		rmdir: (p) => rmdir(path(p)),
	};
	let previous;
	let number = 0;
	const captures = new Map();
	return { fs, captures, async snapshot() {
		const id = ++number;
		if (dataset) zfs('snapshot', `${dataset}@s${id}`);
		const snapPath = dataset ? `${root}/.zfs/snapshot/s${id}` : root;
		const after = await capture(snapPath);
		let events = [];
		if (previous) {
			const raw = dataset ? parseZfsOutput(zfs('diff', '-FHt', `${dataset}@s${id - 1}`, `${dataset}@s${id}`), root) : modelEvents(previous, after);
			events = raw.map((e) => scopeDiffEntry(e, null)).filter(Boolean);
		}
		const result = { before: previous, after, events, snapPath, snap: { id, name: `s${id}`, created_at: id * 100 } };
		previous = after;
		captures.set(id, after);
		await setTimeout(10); // Separate ctime values on the host filesystem.
		return result;
	} };
}

export async function fixture(t, scenario) {
	const w = await workspace(t);
	await scenario.before(w.fs);
	await w.snapshot();
	await scenario.after(w.fs);
	const f = await w.snapshot();
	scenario.checkEvents?.(f.events);
	t.diagnostic(`backend=${zfsParent ? 'zfs' : 'local model'}; events=${JSON.stringify(f.events.map((e) => [e.changeType, e.path, e.newPath]))}`);
	return f;
}

export function seed(db, before) {
	db.exec(`INSERT INTO datasets(id,name,pool,mountpoint) VALUES(1,'messier/apps/nextcloud','messier','/fixture');
		INSERT INTO snapshots(id,dataset_id,name,full_name,created_at,indexed_at) VALUES
		(1,1,'s1','messier/apps/nextcloud@s1',100,1),(2,1,'s2','messier/apps/nextcloud@s2',200,NULL);`);
	const stmt = prepareIndexerStatements(db);
	for (const e of before.values()) {
		if (!isInScope(e.path, e.type === 'dir')) continue;
		const id = stmt.upsertFile.get(1, e.path, Number(e.stat.ino), e.type, 1, 1).id;
		stmt.insertVersion.run(id, 1, e.size, Number(e.stat.mtimeNs / 1000000000n), Number(e.stat.ctimeNs / 1000000000n), Number(e.stat.nlink), (Number(e.stat.mode) & 0o7777).toString(8));
	}
	return stmt;
}

export function performanceCounters() {
	return Object.fromEntries(['statMs', 'statFailures', 'sqlSelects', 'sqlUpserts', 'sqlUpdates', 'sqlInserts', 'sqlTxns', 'sqlMs', 'orphanedChanges', 'diffChanges'].map((k) => [k, 0]));
}

// Call inside database.atomic so fault-injection tests can roll back at any phase.
export async function writeTransition(db, stmt, f, { batchSize = 1, afterBatch, afterFinish } = {}) {
	const context = createSnapshotContext(), perf = performanceCounters();
	for (let i = 0; i < f.events.length; i += batchSize) {
		await flushUnifiedBatch(db, stmt, perf, f.events.slice(i, i + batchSize), f.snap, 1, null, f.snapPath, context);
		await afterBatch?.(i, context);
	}
	finishSnapshot(db, stmt, perf, f.snap, 1, context);
	stmt.markIndexed.run(1, f.snap.id);
	stmt.markDiffDone.run(f.snap.id);
	await afterFinish?.();
	assert.equal(perf.orphanedChanges, 0);
}

export async function timeline(t, setup) {
	const w = await workspace(t);
	await setup(w.fs);
	const baseline = await w.snapshot();
	const db = database.open(':memory:');
	t.after(() => db.close());
	const stmt = seed(db, baseline.after);
	return { db, stmt, captures: w.captures, async step(change = async () => {}) {
		await change(w.fs);
		const f = await w.snapshot();
		if (f.snap.id > 2) db.prepare('INSERT INTO snapshots(id,dataset_id,name,full_name,created_at) VALUES(?,1,?,?,?)')
			.run(f.snap.id, f.snap.name, `${DATASET}@${f.snap.name}`, f.snap.created_at);
		await database.atomic(db, () => writeTransition(db, stmt, f));
		stmt.bumpLastSeen.run(f.snap.id, 1);
		return f;
	} };
}

const MAX_EVENT_ORDERS = 120;

// `zfs diff` promises no order, so a scenario must give the same index whatever order its
// events arrive in. Every order is tried while there are few enough, and beyond that a fixed
// sample, always including the order the backend produced and its reverse.
export function eventOrders(events) {
	const count = events.reduce((total, _, index) => total * (index + 1), 1);
	if (count <= MAX_EVENT_ORDERS) {
		const permute = (list) => (list.length <= 1 ? [list] : list.flatMap((item, index) => permute([...list.slice(0, index), ...list.slice(index + 1)]).map((rest) => [item, ...rest])));
		return permute(events);
	}

	let seed = 0x2F6E2B1;
	const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
	const orders = [events, [...events].reverse()];
	while (orders.length < MAX_EVENT_ORDERS) {
		const order = [...events];
		for (let i = order.length - 1; i > 0; i--) {
			const j = Math.floor(random() * (i + 1));
			[order[i], order[j]] = [order[j], order[i]];
		}
		orders.push(order);
	}
	return orders;
}

export function databaseContents(db) {
	return Object.fromEntries(['datasets', 'snapshots', 'files', 'file_versions', 'changes']
		.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}
