const fs = require('fs');
const { execa } = require('execa');
const FileWatcher = require('../../utils/file_watcher');

let configurationWatcher;

const watchConfigurations = (module) => {
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
			await execa('smbcontrol', ['all', 'reload-config']);
			module.getInternalEmitter().emit('shares:updated');
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
}

module.exports = {
	name: 'watcher',
	register(module) {
		watchConfigurations(module);
	}
};
