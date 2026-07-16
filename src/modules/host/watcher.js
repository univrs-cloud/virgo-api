import fs from 'fs/promises';
import path from 'path';
import touch from 'touch';
import FileWatcher from '../../utils/file_watcher.js';

let setupCompletedWatcher;
let updateLogsWatcher;
let updateProgressWatcher;

// Parse apt's APT::Status-Fd stream. Lines look like `dlstatus:<item>:<percent>:<message>`
// (download) or `pmstatus:<package>:<percent>:<message>` (install); apt already reports the
// overall percentage per stage, so we take the most recent one.
const parseAptProgress = (data) => {
	const lines = data.split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		const parts = lines[i].split(':');
		if (parts[0] !== 'dlstatus' && parts[0] !== 'pmstatus') {
			continue;
		}
		const percent = Math.round(parseFloat(parts[2]));
		if (!Number.isFinite(percent)) {
			continue;
		}
		return {
			stage: (parts[0] === 'dlstatus' ? 'download' : 'install'),
			percent
		};
	}
	return null;
};

const watchSetupCompleted = async (module) => {
	if (setupCompletedWatcher) {
		return setupCompletedWatcher;
	}

	const setupCompletedDir = path.dirname(module.setupCompletedFile);
	setupCompletedWatcher = new FileWatcher(setupCompletedDir);
	setupCompletedWatcher.onChange(async (event, changedPath) => {
		if (changedPath !== module.setupCompletedFile) {
			return;
		}

		if (event === 'add' || event === 'unlink') {
			await syncSetupCompletedState();
		}
	});

	await syncSetupCompletedState();
	return setupCompletedWatcher;

	async function syncSetupCompletedState() {
		let setupCompleted = false;
		try {
			await fs.access(module.setupCompletedFile);
			setupCompleted = true;
		} catch (error) {}

		module.setState('setupCompleted', setupCompleted);
		module.nsp.emit('host:setupCompleted', module.getState('setupCompleted'));
	}
};

const watchUpdateLog = async (module) => {
	if (updateLogsWatcher) {
		return updateLogsWatcher;
	}

	for (const file of [module.updateFile, module.updateProgressFile]) {
		try {
			await fs.access(file);
		} catch (error) {
			await touch(file);
		}
	}

	if (module.getState('update') === undefined && await module.hasActiveUpdateOnDisk()) {
		module.setState('update', {
			steps: [],
			state: 'running'
		});
		await readFile();
		module.emitUpdateState();
	}

	updateLogsWatcher = new FileWatcher(module.updateFile);
	updateLogsWatcher
		.onChange(async (event, path) => {
			readFile();
		})
		.onStop(() => {
			updateLogsWatcher = null;
			updateProgressWatcher?.stop();
			updateProgressWatcher = null;
		});

	updateProgressWatcher = new FileWatcher(module.updateProgressFile);
	updateProgressWatcher.onChange(async () => {
		readFile();
	});
	return updateLogsWatcher;

	async function readFile() {
		const update = module.getState('update');
		if (update?.state === 'succeeded' || update?.state === 'failed') {
			return;
		}

		let steps = update?.steps ?? [];
		try {
			const data = (await fs.readFile(module.updateFile, { encoding: 'utf8', flag: 'r' })).trim();
			if (data !== '') {
				steps = data.split('\n');
			}
		} catch (error) {}

		let progress = update?.progress ?? null;
		try {
			const progressData = (await fs.readFile(module.updateProgressFile, { encoding: 'utf8', flag: 'r' })).trim();
			if (progressData !== '') {
				progress = parseAptProgress(progressData) ?? progress;
			}
		} catch (error) {}

		if (steps.length === 0 && !progress) {
			return;
		}
		module.setState('update', { ...update, steps, progress, state: 'running' });
		module.emitUpdateState();
	}
};

const register = (module) => {
	watchSetupCompleted(module);
};

export default {
	name: 'watcher',
	register,
	watchUpdateLog
};
