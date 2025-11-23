const os = require('os');
const fs = require('fs');
const touch = require('touch');
const { execa } = require('execa');
const si = require('systeminformation');
const { version } = require('../../../package.json');
const BaseModule = require('../base');

class HostModule extends BaseModule {
	#etcHosts = '/etc/hosts';
	#rebootRequiredFile = '/run/reboot-required';
	#updateExitStatusFile = '/var/www/virgo-api/update_exit_code';
	#updatePidFile = '/var/www/virgo-api/update.pid';
	#updateFile = '/var/www/virgo-api/update.log';
	#updatePid = null;
	#checkUpdateIntervalId = null;

	constructor() {
		super('host');

		this.setState('system', {
			api: {
				version: version
			},
			zfs: {
				version: ''
			}
		});
		si.system(async (system) => {
			try {
				const { stdout: zfsVesion } = await execa('zfs', ['version', '--json'], { reject: false });
				this.setState('system', {
					...this.getState('system'),
					...system,
					zfs: { version: JSON.parse(zfsVesion).zfs_version.kernel.replace('zfs-kmod-', '') }
				});
			} catch (error) {
				console.error(error);
			}
		});
		si.cpu((cpu) => {
			this.setState('system', { ...this.getState('system'), cpu });
		});
		this.#loadNetworkIdentifier();
		this.#loadNetworkInterface();
		this.#loadDefaultGateway();

		this.eventEmitter
			.on('host:updates:updated', () => {
				for (const socket of this.nsp.sockets.values()) {
					if (socket.isAuthenticated && socket.isAdmin) {
						this.nsp.to(`user:${socket.username}`).emit('host:updates', this.getState('updates'));
					}
				};
			})
			.on('host:network:identifier:updated', async () => {
				await this.#loadNetworkIdentifier();
				this.nsp.emit('host:system', this.getState('system'));
			})
			.on('host:network:interface:updated', async () => {
				await this.#loadNetworkInterface();
				await this.#loadDefaultGateway();
				this.nsp.emit('host:system', this.getState('system'));
			});
	}

	get etcHosts() {
		return this.#etcHosts;
	}

	get updateExitStatusFile() {
		return this.#updateExitStatusFile;
	}

	get updatePidFile() {
		return this.#updatePidFile;
	}

	get updateFile() {
		return this.#updateFile;
	}

	get updatePid() {
		return this.#updatePid;
	}

	set updatePid(value) {
		this.#updatePid = value;
	}

	get checkUpdateIntervalId() {
		return this.#checkUpdateIntervalId;
	}

	set checkUpdateIntervalId(value) {
		this.#checkUpdateIntervalId = value;
	}

	async onConnection(socket) {
		const pollingPlugin = this.getPlugin('polling');
		pollingPlugin.startPolling(this);

		this.checkUpdate();
		if (this.getState('update') !== undefined) {
			this.nsp.emit('host:update', this.getState('update'));
		}
		if (this.getState('checkUpdates')) {
			if (socket.isAuthenticated && socket.isAdmin) {
				this.nsp.to(`user:${socket.username}`).emit('host:updates:check', this.getState('checkUpdates'));
			}
		}
		if (this.getState('updates')) {
			this.nsp.to(`user:${socket.username}`).emit('host:updates', (socket.isAuthenticated && socket.isAdmin ? this.getState('updates') : []));
		}
		if (this.getState('system')) {
			this.nsp.emit('host:system', this.getState('system'));
		}
		if (this.getState('networkStats')) {
			this.nsp.emit('host:network:stats', this.getState('networkStats'));
		}
		if (this.getState('cpuStats')) {
			this.nsp.emit('host:cpu:stats', this.getState('cpuStats'));
		}
		if (this.getState('memory')) {
			this.nsp.emit('host:memory', this.getState('memory'));
		}
		if (this.getState('storage')) {
			this.nsp.emit('host:storage', this.getState('storage'));
		}
		if (this.getState('drives')) {
			this.nsp.emit('host:drives', this.getState('drives'));
		}
		if (this.getState('time')) {
			this.nsp.emit('host:time', this.getState('time'));
		}
		if (this.getState('reboot') === undefined) {
			this.nsp.emit('host:reboot', false);
		}
		if (this.getState('shutdown') === undefined) {
			this.nsp.emit('host:shutdown', false);
		}
	}

	async checkUpdate() {
		try {
			const updatePid = (await fs.promises.readFile(this.updatePidFile, { encoding: 'utf8', flag: 'r' })).trim();
			this.updatePid = (updatePid === '' ? null : parseInt(updatePid));
		} catch (error) {}
		
		if (this.updatePid === null) {
			this.setState('update', null);
			this.nsp.emit('host:update', this.getState('update'));
			return;
		}
		
		if (this.checkUpdateIntervalId !== null) {
			return;
		}

		let updateLogsWatcher;
		const watcherPlugin = this.getPlugin('watcher');
		if (watcherPlugin) {
			updateLogsWatcher = await watcherPlugin.watchUpdateLog(this);
		}
	
		this.checkUpdateIntervalId = setInterval(async () => {
			if (await this.isUpdateInProgress()) {
				return;
			}
	
			clearInterval(this.checkUpdateIntervalId);
			this.checkUpdateIntervalId = null;
			await updateLogsWatcher?.stop();
			
			let isRebootRequired = false;
			try {
				await fs.promises.access(this.#rebootRequiredFile);
				isRebootRequired = true;
			} catch (error) {}

			let exitCode = 0;
			try {
				exitCode = parseInt((await fs.promises.readFile(this.updateExitStatusFile, { encoding: 'utf8', flag: 'r' })).trim());
			} catch (error) {}
			const state = (exitCode === 0 ? 'succeeded' : 'failed');
			this.setState('update', { ...this.getState('update'), isRebootRequired, state });
			this.nsp.emit('host:update', this.getState('update'));

			this.generateUpdates();
		}, 1000);
	}

	async generateUpdates() {
		try {
			const response = await execa('apt-show-versions', ['-u']);
			const updates = response.stdout.trim();
			if (updates !== '') {
				this.setState('updates', updates.split('\n').map((line) => {
					const parts = line.split(' ').filter((part) => { return part.length > 0; });
					if (parts.length < 5) {
						return null;
					}
					
					return {
						package: parts[0].split(':')[0],
						version: {
							installed: parts[1].split('~')[0],
							updatableTo: parts[4].split('~')[0]
						}
					};
				})?.filter(Boolean));
			} else {
				this.setState('updates', []);
			}
		} catch (error) {
			this.setState('updates', false);
		}
		this.eventEmitter.emit('host:updates:updated');
	}

	async isUpdateInProgress() {
		try {
			if (this.updatePid !== null) {
				try {
					process.kill(this.updatePid, 0);
					return true;
				} catch (error) {
					// PID is dead, but check if apt-get is still running (systemd upgrade case)
				}
	
				// Check if apt-get dist-upgrade is currently running (handles systemd upgrade case)
				try {
					const { stdout } = await execa('pgrep', ['-f', 'apt-get dist-upgrade']);
					const pids = stdout.trim().split('\n');
					if (pids.length > 0 && pids[0] !== '') {
						// Update the PID to the actual running process
						this.updatePid = parseInt(pids[0], 10);
						await fs.promises.writeFile(this.updatePidFile, this.updatePid, 'utf8');
						return true;
					}
				} catch (error) {
					return false;
				}
			}
			
			return false;
		} catch (error) {
			return false;
		}
	}

	async #loadNetworkIdentifier() {
		try {
			const osInfo = await si.osInfo();
			try {
				const { stdout: fqdn } = await execa('hostname', ['-f'], { reject: false });
				osInfo.fqdn = fqdn.toString().split(os.EOL)[0];
			} catch (error) {
				osInfo.fqdn = false;
			}
			try {
				const { stdout: domainName } = await execa('hostname', ['-d'], { reject: false });
				osInfo.domainName = domainName.toString().split(os.EOL)[0];
			} catch (error) {
				osInfo.domainName = false;
			}
			this.setState('system', { ...this.getState('system'), osInfo });
		} catch (error) {
			this.setState('system', { ...this.getState('system'), osInfo: false });
		}
	}

	async #loadDefaultGateway() {
		try {
			const defaultGateway = await si.networkGatewayDefault();
			this.setState('system', { ...this.getState('system'), defaultGateway });
		} catch (error) {
			this.setState('system', { ...this.getState('system'), defaultGateway: false });
		}
	}

	async #loadNetworkInterface() {
		try {
			const networkInterface = await si.networkInterfaces('default');
			this.setState('system', { ...this.getState('system'), networkInterface });
		} catch (error) {
			this.setState('system', { ...this.getState('system'), networkInterface: false });
		}
	}

}

module.exports = () => {
	return new HostModule();
};
