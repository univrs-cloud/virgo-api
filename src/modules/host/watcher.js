const fs = require('fs');
const touch = require('touch');
const FileWatcher = require('../../utils/file_watcher');

let powerSourceWatcher;
let upgradeLogsWatcher;

const watchPowerSource = async (module) => {
	const readFile = async () => {
		let data = await fs.promises.readFile('/tmp/ups_power_source', { encoding: 'utf8', flag: 'r' });
		data = data.trim();
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
		return;
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

const watchUpgradeLog = async (module) => {
	const readFile = async () => {
		let data = await fs.promises.readFile(module.upgradeFile, { encoding: 'utf8', flag: 'r' });
		data = data.trim();
		if (data !== '') {
			module.setState('upgrade', { ...module.getState('upgrade'), steps: data.split('\n') });
			module.nsp.emit('host:upgrade', module.getState('upgrade'));
		}
	};

	if (upgradeLogsWatcher) {
		return;
	}

	try {
		await fs.promises.access(module.upgradeFile);
	} catch (error) {
		await touch(module.upgradeFile);
	}

	if (module.getState('upgrade') === undefined) {
		module.setState('upgrade', {
			state: 'running',
			steps: []
		});
		await readFile();
	}

	upgradeLogsWatcher = new FileWatcher(module.upgradeFile);
	upgradeLogsWatcher
		.onChange(async (event, path) => {
			await readFile();
		});
};

const register = (module) => {
	watchPowerSource(module);
};

module.exports = {
	name: 'watcher',
	register,
	watchUpgradeLog
};
