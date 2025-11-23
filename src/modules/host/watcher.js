const fs = require('fs');
const touch = require('touch');
const FileWatcher = require('../../utils/file_watcher');

let powerSourceWatcher;
let updateLogsWatcher;

const watchPowerSource = async (module) => {
	const readFile = async () => {
		let data = '';
		try {
			data = (await fs.promises.readFile('/tmp/ups_power_source', { encoding: 'utf8', flag: 'r' })).trim();
		} catch (error) {}
		if (data !== '') {
			if (module.getState('ups') === undefined) {
				module.setState('ups', {});
			}
			module.setState('ups', { ...module.getState('ups'), powerSource: data });
			module.nsp.emit('host:ups', module.getState('ups'));
		}
	};

	if (module.i2c === false) {
		return;
	}

	if (powerSourceWatcher) {
		return powerSourceWatcher;
	}

	try {
		await fs.promises.access('/tmp/ups_power_source');
	} catch (error) {
		await touch('/tmp/ups_power_source');
	}

	await readFile();

	powerSourceWatcher = new FileWatcher('/tmp/ups_power_source');
	powerSourceWatcher
		.onChange(async (event, path) => {
			await readFile();
		});
};

const watchUpdateLog = async (module) => {
	const readFile = async () => {
		let data = '';
		try {
			data = (await fs.promises.readFile(module.updateFile, { encoding: 'utf8', flag: 'r' })).trim();
		} catch (error) {}
		if (data !== '') {
			module.setState('update', { ...module.getState('update'), steps: data.split('\n') });
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
			state: 'running',
			steps: []
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

const register = (module) => {
	watchPowerSource(module);
};

module.exports = {
	name: 'watcher',
	register,
	watchUpdateLog
};
