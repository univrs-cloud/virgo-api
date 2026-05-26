const os = require('os');
const fs = require('fs');
const { execa } = require('execa');
const si = require('systeminformation');
const camelcaseKeys = require('camelcase-keys').default;
const { version } = require('../../../package.json');
const BaseModule = require('../base');

class HostModule extends BaseModule {
	#setupCompletedFile = '/var/www/virgo-api/setup_completed';
	#etcHostsFile = '/etc/hosts';
	#rebootRequiredFile = '/run/reboot-required';
	#updateExitStatusFile = '/var/www/virgo-api/update_exit_code';
	#updatePidFile = '/var/www/virgo-api/update.pid';
	#updateFile = '/var/www/virgo-api/update.log';
	#updatePid = null;
	#updateCompletionPromise = null;
	#updateCompletionGeneration = 0;

	constructor() {
		super('host');

		this.#loadSetupCompleted();
		this.checkUpdate();
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
			await Promise.all([
				this.#loadNetworkIdentifier(),
				this.#loadNetworkInterfaces(),
				this.#loadDefaultGateway()
			]);
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

	get setupCompletedFile() {
		return this.#setupCompletedFile;
	}

	get etcHosts() {
		return this.#etcHostsFile;
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

	resetUpdateTracking() {
		this.#updateCompletionGeneration++;
		this.#updateCompletionPromise = null;
		this.updatePid = null;
	}

	async syncUpdatePidFromFile() {
		this.updatePid = await this.#readPidFromFile();
	}

	async #readPidFromFile() {
		try {
			const updatePid = (await fs.promises.readFile(this.updatePidFile, { encoding: 'utf8', flag: 'r' })).trim();
			if (updatePid === '') {
				return null;
			}
			const parsedPid = parseInt(updatePid, 10);
			return Number.isFinite(parsedPid) ? parsedPid : null;
		} catch (error) {
			return null;
		}
	}

	async onConnection(socket) {
		const pollingPlugin = this.getPlugin('polling');
		pollingPlugin?.startPolling(this);

		if (this.getState('setupCompleted') !== undefined) {
			socket.emit('host:setupCompleted', this.getState('setupCompleted'));
		}
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
		if (this.getState('drives')) {
			socket.emit('host:drives', this.getState('drives'));
		}
		if (this.getState('storage')) {
			socket.emit('host:storage', this.getState('storage'));
		}
		if (this.getState('snapshots')) {
			socket.emit('host:storage:snapshots', this.getState('snapshots'));
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
		await this.syncUpdatePidFromFile();
		const exitOnDisk = await this.#readUpdateExitCode();
		const updateState = this.getState('update');

		if (await this.isUpdateInProgress()) {
			this.#startUpdateCompletionTracking();
			return;
		}

		// Update finished (or API restarted before UI acknowledged): exit file is set until completeUpdate clears it.
		if (exitOnDisk !== null) {
			this.#startUpdateCompletionTracking();
			return;
		}

		// No exit on disk — either idle (files missing/empty) or process exited without writing an exit code.
		if (updateState?.state === 'running') {
			this.#startUpdateCompletionTracking();
			return;
		}

		// Idle: pid/exit/log files missing or empty after the user acknowledged completion.
		if (updateState !== undefined && updateState !== null) {
			this.setState('update', null);
			this.nsp.emit('host:update', this.getState('update'));
		}
	}

	#startUpdateCompletionTracking() {
		if (this.#updateCompletionPromise) {
			return;
		}

		const generation = this.#updateCompletionGeneration;
		const watcherPlugin = this.getPlugin('watcher');
		let updateLogsWatcherPromise = Promise.resolve(null);
		if (watcherPlugin) {
			updateLogsWatcherPromise = watcherPlugin.watchUpdateLog(this);
		}

		this.#updateCompletionPromise = updateLogsWatcherPromise
			.then((updateLogsWatcher) => {
				return this.#waitForUpdateCompletion(updateLogsWatcher, generation);
			})
			.finally(() => {
				this.#updateCompletionPromise = null;
			});
	}

	async #readUpdateExitCode() {
		try {
			const exitCodeContent = (await fs.promises.readFile(this.updateExitStatusFile, { encoding: 'utf8', flag: 'r' })).trim();
			if (exitCodeContent === '') {
				return null;
			}
			const exitCode = parseInt(exitCodeContent, 10);
			return Number.isFinite(exitCode) ? exitCode : null;
		} catch (error) {
			return null;
		}
	}

	async #waitForUpdateExitCode() {
		let exitCode = await this.#readUpdateExitCode();
		if (exitCode !== null) {
			return exitCode;
		}

		let retries = 10;
		while (retries > 0) {
			await new Promise((resolve) => { return setTimeout(resolve, 1000); });
			exitCode = await this.#readUpdateExitCode();
			if (exitCode !== null) {
				return exitCode;
			}
			retries--;
		}

		return null;
	}

	async #waitForUpdateCompletion(updateLogsWatcher, generation) {
		while (await this.isUpdateInProgress()) {
			await new Promise((resolve) => { return setTimeout(resolve, 1000); });
		}

		const exitCode = await this.#waitForUpdateExitCode();

		await updateLogsWatcher?.stop();

		if (generation !== this.#updateCompletionGeneration) {
			return;
		}

		let isRebootRequired = false;
		try {
			await fs.promises.access(this.#rebootRequiredFile);
			isRebootRequired = true;
		} catch (error) {}

		if (exitCode === null) {
			console.error('Exit code file is empty or missing after update finished');
		} else {
			console.log(`Update completed - exit code: ${exitCode}`);
		}

		const resolvedExitCode = (exitCode === null ? 1 : exitCode);
		const state = (resolvedExitCode === 0 ? 'succeeded' : 'failed');
		console.log(`Setting update state to: ${state} (exitCode: ${resolvedExitCode})`);
		this.setState('update', { ...this.getState('update'), isRebootRequired, state });
		this.nsp.emit('host:update', this.getState('update'));

		this.generateUpdates();
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
			await this.syncUpdatePidFromFile();

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

	#loadSetupCompleted() {
		try {
			if (fs.existsSync(this.#setupCompletedFile)) { // Check if it exists, if it exists, setup is compelted
				this.setState('setupCompleted', true);
			}
		} catch (error) {
			this.setState('setupCompleted', false);
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
