const fs = require('fs');
const touch = require('touch');
const FileWatcher = require('../../utils/file_watcher');

let powerSourceWatcher;
let upgradeLogsWatcher;

const watchPowerSource = (plugin) => {
	const readFile = () => {
		let data = fs.readFileSync('/tmp/ups_power_source', { encoding: 'utf8', flag: 'r' });
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

	if (!fs.existsSync('/tmp/ups_power_source')) {
		touch.sync('/tmp/ups_power_source');
	}

	readFile();

	powerSourceWatcher = new FileWatcher('/tmp/ups_power_source');
	powerSourceWatcher
		.onChange((event, path) => {
			readFile();
		});
};

const watchUpgradeLog = (plugin) => {
	const readFile = () => {
		let data = fs.readFileSync(plugin.upgradeFile, { encoding: 'utf8', flag: 'r' });
		data = data.trim();
		if (data !== '') {
			plugin.setState('upgrade', { ...plugin.getState('upgrade'), steps: data.split('\n') });
			plugin.getNsp().emit('host:upgrade', plugin.getState('upgrade'));
		}
	};

	if (upgradeLogsWatcher) {
		return;
	}

	if (!fs.existsSync(plugin.upgradeFile)) {
		touch.sync(plugin.upgradeFile);
	}

	if (plugin.getState('upgrade') === undefined) {
		plugin.setState('upgrade', {
			state: 'running',
			steps: []
		});
		readFile();
	}

	upgradeLogsWatcher = new FileWatcher(plugin.upgradeFile);
	upgradeLogsWatcher
		.onChange((event, path) => {
			readFile();
		});
};

module.exports = {
	name: 'watcher',
	register(plugin) {
		watchPowerSource(plugin);
	},
	watchUpgradeLog(plugin) {
		watchUpgradeLog(plugin);
	}
};
