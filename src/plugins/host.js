const os = require('os');
const childProcess = require('child_process');
const si = require('systeminformation');
const { version } = require('../../package.json');
const BasePlugin = require('./base');

let i2c;
try {
	({ I2C } = require('raspi-i2c'));
	i2c = new I2C();
} catch (error) {
	i2c = false;
}

class HostPlugin extends BasePlugin {
	constructor(io) {
		super(io, 'host');
	}

	init() {
		this.upgradePidFile = '/var/www/virgo-api/upgrade.pid';
		this.upgradeFile = '/var/www/virgo-api/upgrade.log';
		this.upgradePid = null;
		this.checkUpgradeIntervalId = null;
		this.i2c = i2c;
		
		// Sub-plugins are automatically loaded by BasePlugin
		
		this.setState('system', {
			api: {
				version: version
			},
			zfs: {
				version: ''
			}
		});
		si.system((system) => {
			try {
				let stdout = childProcess.execSync('zfs version -j 2>/dev/null');
				const parsed = JSON.parse(stdout);
				let zfs = { version: parsed.zfs_version.kernel.replace('zfs-kmod-', '') };
				this.setState('system', { ...this.getState('system'), ...system, zfs });
			} catch (error) {
				console.error(error);
			}
		});
		si.osInfo((osInfo) => {
			try {
				let stdout = childProcess.execSync('hostname -f 2>/dev/null');
				osInfo.fqdn = stdout.toString().split(os.EOL)[0];
				this.setState('system', { ...this.getState('system'), osInfo });
			} catch (error) {
				console.error(error);
			}
		});
		si.cpu((cpu) => {
			this.setState('system', { ...this.getState('system'), cpu });
		});
		si.networkGatewayDefault((defaultGateway) => {
			this.setState('system', { ...this.getState('system'), defaultGateway });
		});
		si.networkInterfaces((networkInterface) => {
			this.setState('system', { ...this.getState('system'), networkInterface });
		}, null, 'default');
		if (i2c === false) {
			this.setState('ups', 'remote i/o error');
		}
	}

	onConnection(socket) {
		const pollingPlugin = this.getPlugin('polling');
		
		this.checkUps();
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
		} else {
			pollingPlugin.pollCpuStats(socket, this);
		}
		if (this.getState('memory')) {
			this.getNsp().emit('host:memory', this.getState('memory'));
		} else {
			pollingPlugin.pollMemory(socket, this);
		}
		if (this.getState('storage')) {
			this.getNsp().emit('host:storage', this.getState('storage'));
		} else {
			pollingPlugin.pollStorage(socket, this);
		}
		if (this.getState('drives')) {
			this.getNsp().emit('host:drives', this.getState('drives'));
		} else {
			pollingPlugin.pollDrives(socket, this);
		}
		if (this.getState('networkStats')) {
			this.getNsp().emit('host:network:stats', this.getState('networkStats'));
		} else {
			pollingPlugin.pollNetworkStats(socket, this);
		}
		if (this.getState('ups')) {
			this.getNsp().emit('host:ups', this.getState('ups'));
		}
		if (this.getState('time')) {
			this.getNsp().emit('host:time', this.getState('time'));
		} else {
			pollingPlugin.pollTime(socket, this);
		}
	}

	async checkForUpdates() {
		const util = require('util');
		const exec = util.promisify(require('child_process').exec);
		
		try {
			const response = await exec('apt-show-versions -u');
			let updates = response.stdout.trim();
			if (updates !== '') {
				this.setState('updates', updates.split('\n').map((line) => {
					let parts = line.split(' ');
					return {
						package: parts[0].split(':')[0],
						version: {
							installed: parts[1].split('~')[0],
							upgradableTo: parts[4].split('~')[0]
						}
					};
				}));
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

	checkUpgrade(socket) {
		const fs = require('fs');
		
		if (!fs.existsSync(this.upgradePidFile)) {
			fs.closeSync(fs.openSync(this.upgradePidFile, 'w'));
		}
		let data = fs.readFileSync(this.upgradePidFile, { encoding: 'utf8', flag: 'r' });
		data = data.trim();
		if (data === '') {
			this.upgradePid = null;
			this.setState('upgrade', undefined);
			this.getNsp().emit('host:upgrade', null);
			return;
		}
	
		this.upgradePid = parseInt(data, 10);
	
		// This will be handled by the watcher sub-plugin
		const watcherPlugin = this.getPlugin('watcher');
		if (watcherPlugin) {
			watcherPlugin.watchUpgradeLog(this);
		}
	
		if (this.checkUpgradeIntervalId !== null) {
			return;
		}
	
		this.checkUpgradeIntervalId = setInterval(async () => {
			if (this.isUpgradeInProgress()) {
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

	isUpgradeInProgress() {
		try {
			process.kill(this.upgradePid, 0);
			return true;
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

}

module.exports = (io) => {
	return new HostPlugin(io);
};
