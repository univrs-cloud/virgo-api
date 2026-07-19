import * as fs from 'fs';

function formatSize(bytes) {
	if (bytes === null || bytes === undefined) {
		return '?';
	}
	const abs = Math.abs(bytes);
	const sign = bytes < 0 ? '-' : '';
	if (abs < 1024) {
		return `${sign}${abs}B`;
	}
	if (abs < 1024 ** 2) {
		return `${sign}${(abs / 1024).toFixed(1)}K`;
	}
	if (abs < 1024 ** 3) {
		return `${sign}${(abs / 1024 ** 2).toFixed(1)}M`;
	}
	return `${sign}${(abs / 1024 ** 3).toFixed(2)}G`;
}

function formatDuration(ms) {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	if (ms < 60000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	const m = Math.floor(ms / 60000);
	const s = ((ms % 60000) / 1000).toFixed(0);
	return `${m}m${s}s`;
}

function acquireLock(dbPath) {
	const lockPath = dbPath + '.lock';
	if (fs.existsSync(lockPath)) {
		const stalePid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
		if (!Number.isInteger(stalePid) || stalePid <= 0) {
			// Empty / truncated / garbage lock file (e.g. a crash mid-write).
			// Never feed a NaN pid to process.kill — that throws EINVAL, not
			// ESRCH, which would wedge every future run behind a dead lock.
			console.warn(`  ⚠  Removing unreadable lock file (${lockPath})`);
			fs.unlinkSync(lockPath);
		} else {
			try {
				process.kill(stalePid, 0);
				throw new Error(`Another indexer is already running (PID ${stalePid}). Lock: ${lockPath}`);
			} catch (e) {
				if (e.code === 'ESRCH') {
					console.warn(`  ⚠  Removing stale lock file (PID ${stalePid} no longer running)`);
					fs.unlinkSync(lockPath);
				} else {
					throw e;
				}
			}
		}
	}
	fs.writeFileSync(lockPath, String(process.pid));
	return lockPath;
}

function releaseLock(lockPath) {
	try {
		fs.unlinkSync(lockPath);
	} catch {
		/* ignore */
	}
}

export { formatSize, formatDuration, acquireLock, releaseLock };
