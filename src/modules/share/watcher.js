const fs = require('fs');
const path = require('path');
const { execa } = require('execa');
const FileWatcher = require('../../utils/file_watcher');

let configurationWatcher;

const watchConfigurations = (module) => {
	if (configurationWatcher) {
		return configurationWatcher;
	}

	configurationWatcher = new FileWatcher([]);
	configurationWatcher
		.onChange(async (event, path) => {
			try {
				await execa('smbcontrol', ['all', 'reload-config']);
				module.eventEmitter.emit('shares:updated');
			} catch (error) {
				console.error(error);
			}
		});

	module.configurationFiles.forEach(configurationPath => {
		try {
			fs.accessSync(configurationPath);
			configurationWatcher.add(configurationPath);
		} catch (error) {
			console.error(`Path does not exist yet: ${configurationPath}`);
		}
	});

	const retryInterval = setInterval(() => {
		let allWatched = true;
		module.configurationFiles.forEach(configurationPath => {
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
			console.log(`All share configurations are now being watched. Stopping retry interval.`);
			clearInterval(retryInterval);
		}
	}, 10000);

	function isPathWatched(pathToCheck) {
		const normalizedPath = path.normalize(pathToCheck);
		const watchedPaths = configurationWatcher.getWatched();
		// If it's a directory
		if (fs.existsSync(normalizedPath) && fs.lstatSync(normalizedPath).isDirectory()) {
			return watchedPaths[normalizedPath] !== undefined;
		}
		// If it's a file
		const dir = path.dirname(normalizedPath);
		const file = path.basename(normalizedPath);
		return watchedPaths[dir] && watchedPaths[dir].includes(file);
	}
};

const register = (module) => {
	watchConfigurations(module);
};

module.exports = {
	name: 'watcher',
	register
};
