import path from 'path';
import fsSync, { promises as fs } from 'fs';
import FileWatcher from './file_watcher.js';

// Presence of this file is what marks first-run setup as done. Everything that needs to know reads
// it through here so the answer can't drift between callers.
const COMPLETED_FILE = '/var/www/virgo-api/setup_completed';

let completed = null;
let watcher = null;
let listeners = [];

/** Cached answer, safe to call per socket event. Falls back to a synchronous read for the window
 * before `watchCompleted()` takes its first reading. */
const isCompleted = () => {
	if (completed === null) {
		try {
			completed = fsSync.existsSync(COMPLETED_FILE);
		} catch (error) {
			// An unreadable path is treated as a finished setup: refusing privileges is recoverable,
			// handing them out on a live node is not.
			completed = true;
		}
	}

	return completed;
};

/** Un-cached read, for when the file is known to have changed under us. */
const read = async () => {
	try {
		await fs.access(COMPLETED_FILE);
		completed = true;
	} catch (error) {
		completed = false;
	}

	return completed;
};

/** Marks first-run setup as done. The cache moves first so the socket asking for it loses its setup
 * privileges immediately, rather than waiting for the watcher to notice the file. */
const complete = async () => {
	await fs.mkdir(path.dirname(COMPLETED_FILE), { recursive: true });
	await fs.writeFile(COMPLETED_FILE, '', 'utf8');
	completed = true;
	notify();
};

const notify = () => {
	for (const listener of listeners) {
		listener(completed);
	}
};

/** Keeps the cached answer in step with the file and hands each change to every listener, starting
 * with the reading taken as the watcher starts. The file only ever appears or disappears, so those
 * are the only events worth re-reading on. */
const watchCompleted = async (onChange) => {
	if (onChange) {
		listeners.push(onChange);
	}

	if (watcher) {
		onChange?.(await read());
		return watcher;
	}

	watcher = new FileWatcher(path.dirname(COMPLETED_FILE));
	watcher.onChange(async (event, changedPath) => {
		if (changedPath !== COMPLETED_FILE) {
			return;
		}

		if (event !== 'add' && event !== 'unlink') {
			return;
		}

		await read();
		notify();
	});

	await read();
	notify();
	return watcher;
};

export {
	isCompleted,
	watchCompleted,
	complete
};
