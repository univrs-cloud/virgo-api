const fs = require('fs');
const touch = require('touch');
const FileWatcher = require('../../utils/file_watcher');

let updateLogsWatcher;

const watchUpdateLog = async (module) => {
	const readFile = async () => {
		let data = '';
		try {
			data = (await fs.promises.readFile(module.updateFile, { encoding: 'utf8', flag: 'r' })).trim();
		} catch (error) {}
		if (data !== '') {
			module.setState('update', { ...module.getState('update'), steps: data.split('\n'), state: 'running' });
			module.nsp.emit('host:update', module.getState('update'));
		}
	};

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
};

module.exports = {
	name: 'watcher',
	watchUpdateLog
};
