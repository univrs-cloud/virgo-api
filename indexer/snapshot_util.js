import { lstat } from 'fs/promises';
import { STAT_FAILURE_ABORT_RATIO, STAT_FAILURE_MIN_SAMPLE, STAT_FAILURE_TOTAL_SAMPLE } from './constants.js';

// Low-level snapshot-mount primitives shared by the walker, the incremental
// flush paths, and the orchestrator. Pure helpers with no DB dependency.

// lstat, not stat: `typeFromStat` can only ever report 'link' for an unfollowed
// stat, and following would record the target's size and inode instead of the
// link's — disagreeing with the walker, which types from the dirent.
export async function safeStatAsync(path) {
	try {
		return await lstat(path);
	} catch {
		return null;
	}
}

/**
 * A snapshot mount that should be readable isn't. Almost always the ZFS
 * `.zfs/snapshot/<name>` automount didn't take.
 */
export function makeSnapshotStatError(snap, snapPath, failures, total) {
	const ratio = total ? (failures / total) : 1;
	const msg = total
		? `Snapshot mount unreadable for ${snap.full_name}: ${failures}/${total} stat() calls failed (${(ratio * 100).toFixed(0)}%). Path=${snapPath}.`
		: `Snapshot mount unreadable for ${snap.full_name}. Path=${snapPath}.`;
	const e = new Error(msg);
	e.code = 'SNAPSHOT_STAT_FAILED';
	return e;
}

export function isSnapshotStatFailure(e) {
	return Boolean(e && e.code === 'SNAPSHOT_STAT_FAILED');
}

/** Shared by the walker and the incremental flush so the two can't drift. */
export function isWholesaleStatFailure(failures, total) {
	if (!total || !failures) {
		return false;
	}
	if (failures === total && total >= STAT_FAILURE_TOTAL_SAMPLE) {
		return true;
	}
	return total >= STAT_FAILURE_MIN_SAMPLE && failures / total >= STAT_FAILURE_ABORT_RATIO;
}

export function resolveRelPath(path, mountpoint) {
	return mountpoint && path.startsWith(mountpoint) ? path.slice(mountpoint.length) || '/' : path;
}

export function sizeFromStat(st) {
	return st.isDirectory() ? 0 : st.size;
}

export function typeFromStat(st) {
	return st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : 'other';
}

export function modeStr(st) {
	return (st.mode & 0o7777).toString(8).padStart(4, '0');
}

/**
 * Touch a snapshot's automount root before a parallel stat/opendir salvo.
 *
 * ZFS auto-mounts `<dataset>/.zfs/snapshot/<name>` lazily on first access;
 * without priming the first big parallel salvo can race the kernel and every
 * call returns ENOENT, silently producing orphan rows for the whole snapshot.
 * Strategy: one stat, one 250 ms pause, one retry. Returns whether the mount
 * became readable — the caller throws its own typed error on false.
 */
export async function primeMountReadable(path) {
	if (await safeStatAsync(path)) {
		return true;
	}
	await new Promise(r => setTimeout(r, 250));
	return Boolean(await safeStatAsync(path));
}
