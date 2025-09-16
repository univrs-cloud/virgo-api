const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const ini = require('ini');
const checkDiskSpace = require('check-disk-space').default;
const BasePlugin = require('./base');
const FileWatcher = require('../utils/file_watcher');

class SharePlugin extends BasePlugin {
	#configurationWatcher;
	#configurationFiles = [
		'/etc/samba/smb.conf',
		'/messier/.shares'
	];

	constructor(io) {
		super(io, 'share');
		this.#watchConfigurations();
	}

	onConnection(socket) {
		const handleShareAction = async (socket, action, config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}
		
			await this.addJob(action, { config, username: socket.username });
		}

		if (this.getState('shares')) {
			this.getNsp().emit('shares', this.getState('shares'));
		}

		socket.on('share:create', async (config) => {
			await handleShareAction(socket, 'share:create', config);
		});

		socket.on('share:update', async (config) => {
			await handleShareAction(socket, 'share:update', config);
		});

		socket.on('share:delete', async (config) => {
			await handleShareAction(socket, 'share:delete', config);
		});
	}

	async processJob(job) {
		if (job.name === 'share:create') {
			return await this.#createShare(job);
		}
		if (job.name === 'share:update') {
			return await this.#updateShare(job);
		}
		if (job.name === 'share:delete') {
			return await this.#deleteShare(job);
		}
	}

	async #watchConfigurations() {
		const isPathWatched = (pathToCheck) => {
			const watchedPaths = this.#configurationWatcher.getWatched();
			const dir = pathToCheck.split('/').slice(0, -1).join('/') || '/';
			const file = pathToCheck.split('/').pop();
			// If it's a directory
			if (fs.existsSync(pathToCheck) && fs.lstatSync(pathToCheck).isDirectory()) {
				return watchedPaths[pathToCheck] !== undefined;
			}
			// If it's a file
			return watchedPaths[dir] && watchedPaths[dir].includes(file);
		}
		
		if (this.#configurationWatcher) {
			return;
		}
	
		if (this.getState('shares') === undefined) {
			this.setState('shares', []);
			this.#emitShares();
		}
	
		this.#configurationWatcher = new FileWatcher([]);
		this.#configurationWatcher
			.onChange(async (event, path) => {
				await exec(`smbcontrol all reload-config`);
				this.#emitShares();
			});
	
		this.#configurationFiles.forEach(configurationPath => {
			try {
				fs.accessSync(configurationPath);
				this.#configurationWatcher.add(configurationPath);
			} catch (error) {
				console.error(`Path does not exist yet: ${configurationPath}`);
			}
		});
	
		const retryInterval = setInterval(() => {
			let allWatched = true;
			this.#configurationFiles.forEach(configurationPath => {
				try {
					fs.accessSync(configurationPath);
					// If path exists but not being watched, add it
					if (!isPathWatched(configurationPath)) {
						this.#configurationWatcher.add(configurationPath);
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

	async #createShare(job) {
		let config = job.data.config;
		return `Share ${config.name} created.`
	}
	
	async #updateShare(job) {
		let config = job.data.config;
		return `Share ${config.name} updated.`
	}
	
	async #deleteShare(job) {
		let config = job.data.config;
		return `Share ${config.name} deleted.`
	}

	async #emitShares() {
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
				this.setState('shares', await Promise.all(promises));
			} catch (error) {
				this.setState('shares', false);
			}
		};

		await getShares();
		this.getNsp().emit('shares', this.getState('shares'));
	}
}

module.exports = (io) => {
	return new SharePlugin(io);
};
