const fs = require('fs');
const touch = require('touch');
const FileWatcher = require('../../utils/file_watcher');

let dataFileWatcher;

const watchConfiguration = async (plugin) => {
	const readFile = async () => {
		let data = await fs.promises.readFile(plugin.dataFile, { encoding: 'utf8', flag: 'r' });
		data = data.trim();
		if (data !== '') {
			plugin.setState('configured', JSON.parse(data));
			plugin.getNsp().emit('app:configured', plugin.getState('configured'));
		}
	};

	if (dataFileWatcher) {
		return;
	}

	try {
		await fs.promises.access(plugin.dataFile);
	} catch (error) {
		await touch(plugin.dataFile);
	}
	
	await readFile();
	
	dataFileWatcher = new FileWatcher(plugin.dataFile);
	dataFileWatcher
		.onChange(async (event, path) => {
			await readFile();
		});
};

module.exports = {
	name: 'watcher',
	register(plugin) {
		watchConfiguration(plugin);
	}
};
