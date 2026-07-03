import fs from 'fs/promises';
import path from 'path';
import touch from 'touch';
import FileWatcher from '../../utils/file_watcher.js';

let setupCompletedWatcher;
let updateLogsWatcher;

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

	try {
		await fs.access(module.updateFile);
	} catch (error) {
		await touch(module.updateFile);
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
		});
	return updateLogsWatcher;

	async function readFile() {
		let data = '';
		try {
			data = (await fs.readFile(module.updateFile, { encoding: 'utf8', flag: 'r' })).trim();
		} catch (error) {}
		if (data !== '') {
			const update = module.getState('update');
			if (update?.state === 'succeeded' || update?.state === 'failed') {
				return;
			}
			module.setState('update', { ...update, steps: data.split('\n'), state: 'running' });
			module.emitUpdateState();
		}
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
