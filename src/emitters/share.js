const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const ini = require('ini');
const checkDiskSpace = require('check-disk-space').default;
const FileWatcher = require('../utils/file_watcher');
const { Queue, Worker } = require('bullmq');

let nsp;
let state = {};
let configurationWatcher;
const configurationFiles = [
	'/etc/samba/smb.conf',
	'/messier/.shares'
];
const queue = new Queue('user-jobs');
const worker = new Worker(
	'share-jobs',
	async (job) => {
		if (job.name === 'createShare') {
			return await createShare(job);
		}
		if (job.name === 'updateShare') {
			return await updateShare(job);
		}
		if (job.name === 'deleteShare') {
			return await deleteShare(job);
		}
	},
	{
		connection: {
			host: 'localhost',
			port: 6379,
		}
	}
);
worker.on('completed', async (job, result) => {
	if (job) {
		await updateProgress(job, result);
	}
});
worker.on('failed', async (job, error) => {
	if (job) {
		await updateProgress(job, ``);
	}
});
worker.on('error', (error) => {
	console.error(error);
});

const updateProgress = async (job, message) => {
	const state = await job.getState();
	await job.updateProgress({ state, message });
};

const watchConfigurations = async () => {
	if (configurationWatcher) {
		return;
	}

	if (state.shares === undefined) {
		state.shares = [];
		getShares();
	}

	configurationWatcher = new FileWatcher([]);
	configurationWatcher
		.onChange(async (event, path) => {
			await exec(`smbcontrol all reload-config`);
			getShares();
		});

	configurationFiles.forEach(configurationPath => {
		try {
			fs.accessSync(configurationPath);
			configurationWatcher.add(configurationPath);
		} catch (error) {
			console.error(`Path does not exist yet: ${configurationPath}`);
		}
	});

	const retryInterval = setInterval(() => {
		let allWatched = true;
		configurationFiles.forEach(configurationPath => {
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

	function isPathWatched(pathToCheck) {
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
};

const getShares = async () => {
	try {
		const response = await exec('testparm -s -l');
		const shares = ini.parse(response.stdout);
		delete shares.global;
		let promises = Object.entries(shares).map(async ([name, value]) => {
			let share = {
				name: name,
				comment: value['comment'],
				validUsers: value['valid users']?.split(' '),
				size: 0,
				free: 0,
				alloc: 0,
				cap: 0,
				isPrivate: (value['guest ok']?.toLowerCase() !== 'yes'),
				isTimeMachine: (value['fruit:time machine'] === 'yes')
			};

			try {
				const diskSpace = await checkDiskSpace(value['path']);
				share.size = diskSpace.size;
				share.free = diskSpace.free;
				share.alloc = share.size - share.free;
				share.cap = share.alloc / share.size * 100;
			} catch (error) {
				console.error(`Error checking disk space for ${name}:`, error);
			}
			return share;
		});
		state.shares = await Promise.all(promises);
	} catch (error) {
		state.shares = false;
	}
	nsp.emit('shares', state.shares);
};

const createShare = async (job) => {
	let config = job.data.config;
	return `Share ${config.name} created.`
};

const updateShare = async (job) => {
	let config = job.data.config;
	return `Share ${config.name} updated.`
};

const deleteShare = async (job) => {
	let config = job.data.config;
	return `Share ${config.name} deleted.`
};

const handleShareAction = async (socket, action, config) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	try {
		await queue.add(action, { config, username: socket.username });
	} catch (error) {
		console.error(`Error starting job:`, error);
	}
};

module.exports = (io) => {
	nsp = io.of('/share');
	nsp.use((socket, next) => {
		socket.isAuthenticated = (socket.handshake.headers['remote-user'] !== undefined);
		socket.isAdmin = (socket.isAuthenticated ? socket.handshake.headers['remote-groups']?.split(',')?.includes('admins') : false);
		socket.username = (socket.isAuthenticated ? socket.handshake.headers['remote-user'] : 'guest');
		next();
	});
	nsp.on('connection', (socket) => {
		socket.join(`user:${socket.username}`);

		if (state.shares) {
			nsp.emit('shares', state.shares);
		}

		socket.on('create', async (config) => {
			await handleShareAction(socket, 'createShare', config);
		});

		socket.on('update', async (config) => {
			await handleShareAction(socket, 'updateShare', config);
		});

		socket.on('delete', async (config) => {
			await handleShareAction(socket, 'deleteShare', config);
		});

		socket.on('disconnect', () => {
			//
		});
	});

	watchConfigurations();
};
