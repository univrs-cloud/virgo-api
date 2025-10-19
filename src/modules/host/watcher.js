const fs = require('fs');
const touch = require('touch');
const FileWatcher = require('../../utils/file_watcher');

let powerSourceWatcher;
let upgradeLogsWatcher;

const watchPowerSource = async (plugin) => {
	const readFile = async () => {
		let data = await fs.promises.readFile('/tmp/ups_power_source', { encoding: 'utf8', flag: 'r' });
		data = data.trim();
		if (data !== '') {
			if (plugin.getState('ups') === undefined) {
				plugin.setState('ups', {});
			}
			plugin.setState('ups', { ...plugin.getState('ups'), powerSource: data });
			plugin.getNsp().emit('host:ups', plugin.getState('ups'));
		}
	};

	if (plugin.i2c === false) {
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

const watchUpgradeLog = async (plugin) => {
	const readFile = async () => {
		let data = await fs.promises.readFile(plugin.upgradeFile, { encoding: 'utf8', flag: 'r' });
		data = data.trim();
		if (data !== '') {
			plugin.setState('upgrade', { ...plugin.getState('upgrade'), steps: data.split('\n') });
			plugin.getNsp().emit('host:upgrade', plugin.getState('upgrade'));
		}
	};

	if (upgradeLogsWatcher) {
		return;
	}

	try {
		await fs.promises.access(plugin.upgradeFile);
	} catch (error) {
		await touch(plugin.upgradeFile);
	}

	if (plugin.getState('upgrade') === undefined) {
		plugin.setState('upgrade', {
			state: 'running',
			steps: []
		});
		await readFile();
	}

	upgradeLogsWatcher = new FileWatcher(plugin.upgradeFile);
	upgradeLogsWatcher
		.onChange(async (event, path) => {
			await readFile();
		});
};

module.exports = {
	name: 'watcher',
	register(plugin) {
		watchPowerSource(plugin);
	},
	watchUpgradeLog
};
