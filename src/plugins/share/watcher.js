const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const FileWatcher = require('../../utils/file_watcher');

let configurationWatcher;

const watchConfigurations = async (plugin) => {
	const isPathWatched = (pathToCheck) => {
		const watchedPaths = configurationWatcher.getWatched();
		const dir = pathToCheck.split('/').slice(0, -1).join('/') || '/';
		const file = pathToCheck.split('/').pop();
		// If it's a directory
		if (fs.existsSync(pathToCheck) && fs.lstatSync(pathToCheck).isDirectory()) {
			return watchedPaths[pathToCheck] !== undefined;
		}
		// If it's a file
		return watchedPaths[dir] && watchedPaths[dir].includes(file);
	}
	
	if (configurationWatcher) {
		return;
	}

	configurationWatcher = new FileWatcher([]);
	configurationWatcher
		.onChange(async (event, path) => {
			await exec(`smbcontrol all reload-config`);
			plugin.emitShares();
		});

	plugin.configurationFiles.forEach(configurationPath => {
		try {
			fs.accessSync(configurationPath);
			configurationWatcher.add(configurationPath);
		} catch (error) {
			console.error(`Path does not exist yet: ${configurationPath}`);
		}
	});

	const retryInterval = setInterval(() => {
		let allWatched = true;
		plugin.configurationFiles.forEach(configurationPath => {
			try {
				fs.accessSync(configurationPath);
				// If path exists but not being watched, add it
				if (!isPathWatched(configurationPath)) {
					configurationWatcher.add(configurationPath);
				}
			} catch (error) {
				allWatched = false;
				console.log(`Waiting for path to exist: ${configurationPath}`);
			}
		});

		if (allWatched) {
			console.log('All share configurations are now being watched. Stopping retry interval.');
			clearInterval(retryInterval);
		}
	}, 10000);
}

module.exports = {
	register(plugin) {
		watchConfigurations(plugin);
	}
};
