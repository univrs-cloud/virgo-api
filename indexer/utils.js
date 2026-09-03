import * as fs from 'fs';
import prettyBytes from 'pretty-bytes';
import prettyMilliseconds from 'pretty-ms';

function formatSize(value) {
	if (value === null || value === undefined) {
		return '?';
	}
	return prettyBytes(value, { binary: true });
}

function formatDuration(ms) {
	return prettyMilliseconds(ms);
}

/**
 * Take the indexer lock, or throw if another run holds it.
 *
 * The claim is a single `wx` open, so two runs starting together can't both win —
 * an existence check followed by a write left a window where they could. A lock
 * left behind by a killed run is cleared only after its PID is confirmed gone.
 */
function acquireLock(dbPath) {
	const lockPath = dbPath + '.lock';

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = fs.openSync(lockPath, 'wx');
			try {
				fs.writeSync(fd, String(process.pid));
			} finally {
				fs.closeSync(fd);
			}
			return lockPath;
		} catch (e) {
			if (e.code !== 'EEXIST' || attempt > 0) {
				throw e;
			}
		}

		const holder = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
		if (!Number.isInteger(holder) || holder <= 0) {
			// Empty / truncated / garbage lock file (e.g. a crash mid-write).
			// Never feed a NaN pid to process.kill — that throws EINVAL, not
			// ESRCH, which would wedge every future run behind a dead lock.
			console.warn(`  ⚠  Removing unreadable lock file (${lockPath})`);
			fs.unlinkSync(lockPath);
			continue;
		}
		try {
			process.kill(holder, 0);
		} catch (e) {
			if (e.code === 'ESRCH') {
				console.warn(`  ⚠  Removing stale lock file (PID ${holder} no longer running)`);
				fs.unlinkSync(lockPath);
				continue;
			}
			throw e;
		}
		const busy = new Error(`Another indexer is already running (PID ${holder}). Lock: ${lockPath}`);
		busy.code = 'INDEXER_LOCKED';
		throw busy;
	}

	const busy = new Error(`Could not acquire the indexer lock: ${lockPath}`);
	busy.code = 'INDEXER_LOCKED';
	throw busy;
}

function releaseLock(lockPath) {
	try {
		fs.unlinkSync(lockPath);
	} catch {
		/* ignore */
	}
}

export { formatSize, formatDuration, acquireLock, releaseLock };
