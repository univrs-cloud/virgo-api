const fs = require('fs');
const path = require('path');
const { execa } = require('execa');
const ini = require('ini');
const FileWatcher = require('../../utils/file_watcher');
const TimeMachine = require('../../utils/time_machine');

let configurationWatcher;
let timeMachineWatcher;

const watchConfigurations = (module) => {
	const isPathWatched = (pathToCheck) => {
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
	};
	
	if (configurationWatcher) {
		return configurationWatcher;
	}

	configurationWatcher = new FileWatcher([]);
	configurationWatcher
		.onChange(async (event, path) => {
			try {
				await execa('smbcontrol', ['all', 'reload-config']);
				watchTimeMachines(module);
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
};

const getTimeMachinePathsFromConfig = async () => {
	try {
		const response = await execa('testparm', ['-s', '-l']);
		const shares = ini.parse(response.stdout);
		delete shares.global;
		const timeMachinePaths = Object.values(shares)
			.filter((share) => {
				return share['fruit:time machine'] === 'yes' && share.path;
			})
			.map((share) => {
				return share.path;
			});
		const machineArrays = await Promise.all(
			timeMachinePaths.map((backupPath) => {
				return TimeMachine.getMachines(backupPath);
			})
		);
		return machineArrays.flatMap((machines) => {
			return machines.flatMap((machine) => {
				return [machine.resultsPath, machine.snapshotHistoryPath];
			});
		});
	} catch {
		return [];
	}
};

const watchTimeMachines = async (module) => {
	const paths = await getTimeMachinePathsFromConfig();

	if (!timeMachineWatcher) {
		timeMachineWatcher = new FileWatcher([]);
		timeMachineWatcher.onChange(async (event, path) => {
			module.eventEmitter.emit('shares:updated');
		});
	}

	// Add all paths (chokidar handles duplicates gracefully)
	paths.forEach((plistPath) => {
		try {
			timeMachineWatcher.add(plistPath);
		} catch (error) {
			console.error(`Could not watch ${plistPath}:`, error);
		}
	});

	
	// Give chokidar a moment to update
	await new Promise(resolve => setTimeout(resolve, 100));
	
	// Remove paths that are no longer in the config
	const watched = timeMachineWatcher.getWatched();
	const normalizedPaths = new Set(paths.map((plistPath) => {
		return path.normalize(plistPath);
	}));
	Object.keys(watched).forEach((directory) => {
		(watched[directory] || []).forEach((filename) => {
			const watchedPath = path.join(directory, filename);
			if (!normalizedPaths.has(path.normalize(watchedPath))) {
				timeMachineWatcher.remove(watchedPath);
			}
		});
	});
};

const register = (module) => {
	watchConfigurations(module);
	watchTimeMachines(module);
};

module.exports = {
	name: 'watcher',
	register
};
