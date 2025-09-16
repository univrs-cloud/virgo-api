const fs = require('fs');
const touch = require('touch');
const FileWatcher = require('../../utils/file_watcher');

let dataFileWatcher;

const watchConfiguration = (plugin) => {
	const readFile = () => {
		let data = fs.readFileSync(plugin.dataFile, { encoding: 'utf8', flag: 'r' });
		data = data.trim();
		if (data !== '') {
			plugin.setState('configured', JSON.parse(data));
			plugin.getNsp().emit('app:configured', plugin.getState('configured'));
		}
	};

	if (dataFileWatcher) {
		return;
	}

	if (!fs.existsSync(plugin.dataFile)) {
		touch.sync(plugin.dataFile);
	}
	
	readFile();
	
	dataFileWatcher = new FileWatcher(plugin.dataFile);
	dataFileWatcher
		.onChange((event, path) => {
			readFile();
		});
};

module.exports = {
	name: 'watcher',
	register(plugin) {
		watchConfiguration(plugin);
	}
};
