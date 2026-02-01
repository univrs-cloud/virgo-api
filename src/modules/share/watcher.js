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
}

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

	const watched = timeMachineWatcher.getWatched();
	const watchedPaths = Object.keys(watched).flatMap((directory) => {
		return (watched[directory] || []).map((filename) => {
			return path.join(directory, filename);
		});
	});

	const normalizedPaths = new Set(paths.map((plistPath) => {
		return path.normalize(plistPath);
	}));
	const normalizedWatched = new Set(watchedPaths.map((watchedPath) => {
		return path.normalize(watchedPath);
	}));

	paths.forEach((plistPath) => {
		if (!normalizedWatched.has(path.normalize(plistPath))) {
			try {
				timeMachineWatcher.add(plistPath);
			} catch (error) {
				console.error(`Could not watch ${plistPath}:`, error);
			}
		}
	});

	watchedPaths.forEach((watchedPath) => {
		if (!normalizedPaths.has(path.normalize(watchedPath))) {
			timeMachineWatcher.remove(watchedPath);
		}
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
