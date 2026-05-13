'use strict';

const { opendir, stat } = require('fs/promises');
const { isNoisePath } = require('./scope');

const BATCH_SIZE = 4096;
const STAT_CONCURRENCY = 64;

/**
 * Depth-first crawl of a snapshot mount. Runs entirely on the main thread so we
 * avoid worker <-> main IPC and lock-free ring races that were wedging crawls on Pi.
 *
 * Stats are performed asynchronously in batches to avoid blocking the event loop.
 */
async function walkSnapshot(snapshotPath, onBatch) {
	const dirs = [snapshotPath];
	let pending = [];
	let total = 0;
	let skippedDirs = 0;
	let statFailures = 0;

	async function statBatch(entries) {
		const results = new Array(entries.length);
		for (let i = 0; i < entries.length; i += STAT_CONCURRENCY) {
			const slice = entries.slice(i, i + STAT_CONCURRENCY);
			const stats = await Promise.all(slice.map(e =>
				stat(e.fullPath).catch(() => {
					statFailures++;
					return null;
				})
			));
			for (let j = 0; j < slice.length; j++) {
				results[i + j] = stats[j];
			}
		}
		return results;
	}

	async function flush() {
		if (!pending.length) {
			return;
		}
		const chunk = pending.splice(0, pending.length);

		const stats = await statBatch(chunk);
		const batch = [];
		for (let i = 0; i < chunk.length; i++) {
			const e = chunk[i];
			const st = stats[i];
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

				if (pending.length >= BATCH_SIZE) await flush();
			}
			for (let i = childDirs.length - 1; i >= 0; i--) {
				dirs.push(childDirs[i]);
			}
		} catch {
			skippedDirs++;
		}
	}

	await flush();

	if (skippedDirs > 0) {
		console.warn(`    ⚠  ${skippedDirs} director${skippedDirs === 1 ? 'y' : 'ies'} skipped (permission denied or gone)`);
	}
	if (statFailures > 0) {
		console.warn(`    ⚠  ${statFailures} file${statFailures === 1 ? '' : 's'} skipped (stat failed)`);
	}

	return total;
}

module.exports = { walkSnapshot };
