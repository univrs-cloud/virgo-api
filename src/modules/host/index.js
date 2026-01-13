const os = require('os');
const fs = require('fs');
const { execa } = require('execa');
const si = require('systeminformation');
const camelcaseKeys = require('camelcase-keys').default;
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
				const { stdout: zfsVesion } = await execa('zfs', ['version', '--json']);
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
		(async () => {
			await this.#loadNetworkIdentifier();
			await this.#loadNetworkInterfaces();
			await this.#loadDefaultGateway();
		})();

		this.eventEmitter
			.on('host:updates:updated', () => {
				for (const socket of this.nsp.sockets.values()) {
					if (socket.isAuthenticated && socket.isAdmin) {
						socket.emit('host:updates', this.getState('updates'));
					}
				};
			})
			.on('host:network:identifier:updated', async () => {
				await this.#loadNetworkIdentifier();
				this.nsp.emit('host:system', this.getState('system'));
			})
			.on('host:network:interface:updated', async () => {
				await this.#loadNetworkInterfaces();
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
		pollingPlugin?.startPolling(this);

		this.checkUpdate();
		if (this.getState('update') !== undefined) {
			socket.emit('host:update', this.getState('update'));
		}
		if (this.getState('system')) {
			socket.emit('host:system', this.getState('system'));
		}
		if (this.getState('networkStats')) {
			socket.emit('host:network:stats', this.getState('networkStats'));
		}
		if (this.getState('cpuStats')) {
			socket.emit('host:cpu:stats', this.getState('cpuStats'));
		}
		if (this.getState('memory')) {
			socket.emit('host:memory', this.getState('memory'));
		}
		if (this.getState('storage')) {
			socket.emit('host:storage', this.getState('storage'));
		}
		if (this.getState('drives')) {
			socket.emit('host:drives', this.getState('drives'));
		}
		if (this.getState('time')) {
			socket.emit('host:time', this.getState('time'));
		}
		if (this.getState('reboot') === undefined) {
			socket.emit('host:reboot', false);
		}
		if (this.getState('shutdown') === undefined) {
			socket.emit('host:shutdown', false);
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
	
			// Wait for exit code file to be written (handle race condition)
			let exitCodeContent = '';
			let retries = 10; // Wait up to 10 seconds for the file to be written
			while (retries > 0 && exitCodeContent === '') {
				try {
					exitCodeContent = (await fs.promises.readFile(this.updateExitStatusFile, { encoding: 'utf8', flag: 'r' })).trim();
					if (exitCodeContent === '') {
						// File exists but is empty, wait a bit and retry
						await new Promise(resolve => setTimeout(resolve, 1000));
						retries--;
						continue;
					}
				} catch (error) {
					// File doesn't exist yet, wait and retry
					await new Promise(resolve => setTimeout(resolve, 1000));
					retries--;
					continue;
				}
				break;
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
			if (exitCodeContent !== '') {
				exitCode = parseInt(exitCodeContent);
				if (isNaN(exitCode)) {
					console.error(`Failed to parse exit code from file content: "${exitCodeContent}"`);
					exitCode = 1; // Treat unparseable content as failure
				}
				console.log(`Update completed - exit code file content: "${exitCodeContent}", parsed: ${exitCode}`);
			} else {
				console.error(`Exit code file is empty or missing after retries`);
				exitCode = 1; // Treat missing/empty file as failure
			}
			const state = (exitCode === 0 ? 'succeeded' : 'failed');
			console.log(`Setting update state to: ${state} (exitCode: ${exitCode})`);
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

	async #getInterfaceSpeed(ifname) {
		try {
			let targetInterface = ifname;
			const bondingPath = `/sys/class/net/${ifname}/bonding/active_slave`;
			if (fs.existsSync(bondingPath)) { // Check if it's a bond interface
				const activeSlave = await fs.promises.readFile(bondingPath, 'utf8');
				if (activeSlave.trim()) {
					targetInterface = activeSlave.trim();
				}
			}
			const speed = await fs.promises.readFile(`/sys/class/net/${targetInterface}/speed`, 'utf8');
			const speedValue = parseInt(speed.trim(), 10);
			return (isNaN(speedValue) || speedValue < 0) ? 0 : speedValue;
		} catch {
			return 0;
		}
	}

	async #waitForInterfaceSpeed(ifname, timeoutMs = 6000, intervalMs = 500) {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const speed = await this.#getInterfaceSpeed(ifname);
			if (speed > 0) {
				return speed;
			}
			await new Promise((resolve) => { return setTimeout(resolve, intervalMs); });
		}
		return 0;
	}

	async #loadNetworkInterfaces() {
		try {
			const { stdout: addrOutput } = await execa('ip', ['-j', 'addr', 'show']);
			const { stdout: defaultRoutesOutput } = await execa('ip', ['-j', 'route', 'show', 'default']);
			const networkInterfaces = camelcaseKeys(JSON.parse(addrOutput), { deep: true });
			const defaultRoutes = JSON.parse(defaultRoutesOutput);
			let defaultDev = null;
			if (defaultRoutes.length > 0 && defaultRoutes[0].dev) {
				defaultDev = defaultRoutes[0].dev;
			}
			for (const iface of networkInterfaces) {
				iface.default = (defaultDev !== null && iface.ifname === defaultDev);
				if (iface.default) {
					iface.speed = await this.#waitForInterfaceSpeed(iface.ifname);
				} else {
					iface.speed = await this.#getInterfaceSpeed(iface.ifname);
				}
			}
			this.setState('system', { ...this.getState('system'), networkInterfaces });
		} catch (error) {
			this.setState('system', { ...this.getState('system'), networkInterfaces: false });
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
}

module.exports = () => {
	return new HostModule();
};
