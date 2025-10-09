const os = require('os');
const fs = require('fs');
const touch = require('touch');
const { execa } = require('execa');
const si = require('systeminformation');
const { version } = require('../../../package.json');
const BasePlugin = require('../base');

let i2c;
try {
	({ I2C } = require('raspi-i2c'));
	i2c = new I2C();
} catch (error) {
	i2c = false;
}

class HostPlugin extends BasePlugin {
	#i2c = i2c;
	#etcHosts = '/etc/hosts';
	#upgradePidFile = '/var/www/virgo-api/upgrade.pid';
	#upgradeFile = '/var/www/virgo-api/upgrade.log';
	#upgradePid = null;
	#checkUpgradeIntervalId = null;

	constructor(io) {
		super(io, 'host');

		if (this.i2c === false) {
			this.setState('ups', 'remote i/o error');
		}
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
				const { stdout } = await execa('zfs', ['version', '-j'], { reject: false });
				const parsed = JSON.parse(stdout);
				let zfs = { version: parsed.zfs_version.kernel.replace('zfs-kmod-', '') };
				this.setState('system', { ...this.getState('system'), ...system, zfs });
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

		this.checkUps();

		this.getInternalEmitter()
			.on('host:network:identifier:updated', async () => {
				await this.#loadNetworkIdentifier();
				this.getNsp().emit('host:system', this.getState('system'));
			})
			.on('host:network:interface:updated', async () => {
				await this.#loadNetworkInterface();
				await this.#loadDefaultGateway();
				this.getNsp().emit('host:system', this.getState('system'));
			});
	}

	get i2c() {
		return this.#i2c;
	}

	get etcHosts() {
		return this.#etcHosts;
	}

	get upgradePidFile() {
		return this.#upgradePidFile;
	}

	get upgradeFile() {
		return this.#upgradeFile;
	}

	get upgradePid() {
		return this.#upgradePid;
	}

	set upgradePid(value) {
		return this.#upgradePid = value;
	}

	get checkUpgradeIntervalId() {
		return this.#checkUpgradeIntervalId;
	}

	set checkUpgradeIntervalId(value) {
		return this.#checkUpgradeIntervalId = value;
	}

	async onConnection(socket) {
		const pollingPlugin = this.getPlugin('polling');
		pollingPlugin.startPolling(socket, this);
		
		this.checkUpgrade(socket);

		this.getNsp().emit('host:system', this.getState('system'));
		if (this.getState('reboot') === undefined) {
			this.getNsp().emit('host:reboot', false);
		}
		if (this.getState('shutdown') === undefined) {
			this.getNsp().emit('host:shutdown', false);
		}
		if (this.getState('checkUpdates')) {
			if (socket.isAuthenticated && socket.isAdmin) {
				this.getNsp().to(`user:${socket.username}`).emit('host:updates:check', this.getState('checkUpdates'));
			}
		}
		if (this.getState('updates')) {
			this.getNsp().to(`user:${socket.username}`).emit('host:updates', (socket.isAuthenticated && socket.isAdmin ? this.getState('updates') : []));
		} else {
			this.checkForUpdates();
		}
		if (this.getState('cpuStats')) {
			this.getNsp().emit('host:cpu:stats', this.getState('cpuStats'));
		}
		if (this.getState('memory')) {
			this.getNsp().emit('host:memory', this.getState('memory'));
		}
		if (this.getState('storage')) {
			this.getNsp().emit('host:storage', this.getState('storage'));
		}
		if (this.getState('drives')) {
			this.getNsp().emit('host:drives', this.getState('drives'));
		}
		if (this.getState('networkStats')) {
			this.getNsp().emit('host:network:stats', this.getState('networkStats'));
		}
		if (this.getState('ups')) {
			this.getNsp().emit('host:ups', this.getState('ups'));
		}
		if (this.getState('time')) {
			this.getNsp().emit('host:time', this.getState('time'));
		}
	}

	async checkForUpdates() {
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
							upgradableTo: parts[4].split('~')[0]
						}
					};
				}).filter(Boolean));
			} else {
				this.setState('updates', []);
			}
		} catch (error) {
			this.setState('updates', false);
		}
	
		for (const socket of this.getNsp().sockets.values()) {
			if (socket.isAuthenticated && socket.isAdmin) {
				this.getNsp().to(`user:${socket.username}`).emit('host:updates:check', this.getState('checkUpdates'));
				this.getNsp().to(`user:${socket.username}`).emit('host:updates', this.getState('updates'));
			}
		};
		return ``;
	}

	async checkUps() {
		if (this.i2c === false) {
			this.getNsp().emit('host:ups', this.getState('ups'));
			return;
		}
	
		if (this.getState('ups') === undefined) {
			this.setState('ups', {});
		}
	
		let batteryCharge;
		try {
			batteryCharge = this.i2c.readByteSync(0x36, 4);
		} catch (error) {
			batteryCharge = false;
		}
		this.setState('ups', { ...this.getState('ups'), batteryCharge });
		
		this.getNsp().emit('host:ups', this.getState('ups'));
	}

	async checkUpgrade(socket) {
		try {
			await fs.promises.access(this.upgradePidFile);
		} catch (error) {
			await touch(this.upgradePidFile);
		}

		let upgradePid = await fs.promises.readFile(this.upgradePidFile, { encoding: 'utf8', flag: 'r' });
		upgradePid = upgradePid.trim();
		this.upgradePid = (upgradePid === '' ? null : parseInt(upgradePid, 10));

		if (this.upgradePid === null) {
			this.setState('upgrade', undefined);
			this.getNsp().emit('host:upgrade', null);
			return;
		}
	
		// This will be handled by the watcher sub-plugin
		const watcherPlugin = this.getPlugin('watcher');
		if (watcherPlugin) {
			watcherPlugin.watchUpgradeLog(this);
		}
	
		if (this.checkUpgradeIntervalId !== null) {
			return;
		}
	
		this.checkUpgradeIntervalId = setInterval(async () => {
			if (await this.isUpgradeInProgress()) {
				return;
			}
	
			clearInterval(this.checkUpgradeIntervalId);
			this.checkUpgradeIntervalId = null;
			const watcherPlugin = this.getPlugin('watcher');
			if (watcherPlugin && watcherPlugin.upgradeLogsWatcher) {
				await watcherPlugin.upgradeLogsWatcher.stop();
				watcherPlugin.upgradeLogsWatcher = undefined;
			}
			this.setState('upgrade', { ...this.getState('upgrade'), state: 'succeeded' });
			this.getNsp().emit('host:upgrade', this.getState('upgrade'));
			this.updates(socket);
		}, 1000);
	}

	async isUpgradeInProgress() {
		try {
			if (this.upgradePid !== null) {
				try {
					process.kill(this.upgradePid, 0);
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
						this.upgradePid = parseInt(pids[0], 10);
						await fs.promises.writeFile(this.upgradePidFile, this.upgradePid, 'utf8');
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

	updates(socket) {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			this.getNsp().to(`user:${socket.username}`).emit('host:updates', false);
			return;
		}
	
		if (this.upgradePid === null) {
			this.getNsp().emit('host:upgrade', null);
		}
		this.checkForUpdates();
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

module.exports = (io) => {
	return new HostPlugin(io);
};
