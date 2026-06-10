import { opendir, stat } from 'fs/promises';
import { isNoisePath } from './scope.js';

const BATCH_SIZE = 4096;
const STAT_CONCURRENCY = 64;

// If a flush's stat() failure rate goes wholesale (>=50% of >=32 entries), it
// means the snapshot mount has gone away mid-crawl. Abort instead of silently
// dropping batches of files.
const STAT_FAILURE_ABORT_RATIO = 0.5;
const STAT_FAILURE_MIN_SAMPLE = 32;

function makeMountError(snapshotPath, detail) {
	const e = new Error(`Snapshot mount unreadable for ${snapshotPath}: ${detail}`);
	e.code = 'SNAPSHOT_STAT_FAILED';
	return e;
}

/**
 * Prime the snapshot's automount before we hit it with a parallel `opendir`
 * salvo. One stat, 250 ms pause, one retry. Identical logic to the
 * incremental-path primer; deliberately not de-duplicated to keep the
 * walker self-contained (the indexer's primer lives in index.js where it
 * has access to `safeStatAsync`).
 */
async function primeMount(snapshotPath) {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await stat(snapshotPath);
			return;
		} catch {
			if (attempt === 0) {
				await new Promise(r => setTimeout(r, 250));
			}
		}
	}
	throw makeMountError(snapshotPath, 'root stat() failed twice; .zfs automount likely not ready.');
}

/**
 * Depth-first crawl of a snapshot mount. Runs entirely on the main thread so we
 * avoid worker <-> main IPC and lock-free ring races that were wedging crawls on Pi.
 *
 * Stats are performed asynchronously in batches to avoid blocking the event loop.
 *
 * Returns `{ total, statFailures, skippedDirs }` so the caller can surface
 * silent-drop counts in the run summary. Throws `SNAPSHOT_STAT_FAILED` if the
 * mount becomes unreadable wholesale (either at start or mid-crawl).
 */
async function walkSnapshot(snapshotPath, onBatch) {
	await primeMount(snapshotPath);

	const dirs = [snapshotPath];
	let pending = [];
	let total = 0;
	let skippedDirs = 0;
	let statFailures = 0;

	async function statBatch(entries) {
		const results = new Array(entries.length);
		let localFailures = 0;
		for (let i = 0; i < entries.length; i += STAT_CONCURRENCY) {
			const slice = entries.slice(i, i + STAT_CONCURRENCY);
			const stats = await Promise.all(slice.map(e =>
				stat(e.fullPath).catch(() => {
					localFailures++;
					statFailures++;
					return null;
				})
			));
			for (let j = 0; j < slice.length; j++) {
				results[i + j] = stats[j];
			}
		}
		return { results, localFailures };
	}

	async function flush() {
		if (!pending.length) {
			return;
		}
		const chunk = pending.splice(0, pending.length);

		const { results, localFailures } = await statBatch(chunk);
		if (chunk.length >= STAT_FAILURE_MIN_SAMPLE && localFailures / chunk.length >= STAT_FAILURE_ABORT_RATIO) {
			throw makeMountError(
				snapshotPath,
				`${localFailures}/${chunk.length} stat() calls failed mid-crawl (${(localFailures / chunk.length * 100).toFixed(0)}%). Mount likely went away.`
			);
		}
		const batch = [];
		for (let i = 0; i < chunk.length; i++) {
			const e = chunk[i];
			const st = results[i];
			if (!st) {
				continue;
			}

			const size = e.isDir ? 0 : st.size;
			const type = e.isDir ? 'dir'
								 : e.isLink ? 'link'
								 : e.isFile ? 'file'
								 : 'other';

			batch.push({
				path: e.relPath,
				type,
				inode: st.ino,
				size,
				mtime: Math.floor(st.mtimeMs / 1000),
				ctime: Math.floor(st.ctimeMs / 1000),
				nlink: st.nlink,
				mode: (st.mode & 0o7777).toString(8).padStart(4, '0'),
			});
		}

		if (batch.length) {
			total += batch.length;
			onBatch(batch);
		}
		await new Promise(r => setImmediate(r));
	}

	while (dirs.length) {
		const dir = dirs.pop();
		try {
			const d = await opendir(dir, { bufferSize: 512 });
			const childDirs = [];
			for await (const entry of d) {
				const fullPath = `${dir === '/' ? '' : dir}/${entry.name}`;
				const relPath = fullPath.startsWith(snapshotPath)
					? fullPath.slice(snapshotPath.length) || '/'
					: fullPath;

				if (entry.isDirectory() && isNoisePath(relPath)) {
					continue;
				}

				pending.push({
					fullPath,
					relPath,
					isDir: entry.isDirectory(),
					isLink: entry.isSymbolicLink(),
					isFile: entry.isFile(),
				});

				if (entry.isDirectory() && entry.name !== '.zfs') {
					childDirs.push(fullPath);
				}

				if (pending.length >= BATCH_SIZE) {
					await flush();
				}
			}
			for (let i = childDirs.length - 1; i >= 0; i--) {
				dirs.push(childDirs[i]);
			}
		} catch (err) {
			// Permission denied / file disappeared mid-iteration are normal-ish.
			// EIO / ENXIO / ENOENT at the snapshot root would have been caught
			// by primeMount already; here we only swallow per-directory failures.
			if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ENOENT' || err.code === 'ESTALE') {
				skippedDirs++;
			} else {
				throw err;
			}
		}
	}

	await flush();

	if (skippedDirs > 0) {
		console.warn(`    ⚠  ${skippedDirs} director${skippedDirs === 1 ? 'y' : 'ies'} skipped (permission denied or gone)`);
	}
	if (statFailures > 0) {
		console.warn(`    ⚠  ${statFailures} file${statFailures === 1 ? '' : 's'} skipped (stat failed)`);
	}

	return { total, statFailures, skippedDirs };
}

export { walkSnapshot };
