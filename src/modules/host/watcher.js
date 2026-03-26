const fs = require('fs');
const path = require('path');
const touch = require('touch');
const FileWatcher = require('../../utils/file_watcher');

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
			await fs.promises.access(module.setupCompletedFile);
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
		await fs.promises.access(module.updateFile);
	} catch (error) {
		await touch(module.updateFile);
	}

	if (module.getState('update') === undefined) {
		module.setState('update', {
			steps: [],
			state: 'running'
		});
		await readFile();
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
			data = (await fs.promises.readFile(module.updateFile, { encoding: 'utf8', flag: 'r' })).trim();
		} catch (error) {}
		if (data !== '') {
			module.setState('update', { ...module.getState('update'), steps: data.split('\n'), state: 'running' });
			module.nsp.emit('host:update', module.getState('update'));
		}
	}
};

const register = (module) => {
	watchSetupCompleted(module);
};

module.exports = {
	name: 'watcher',
	register,
	watchUpdateLog
};
