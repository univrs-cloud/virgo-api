const os = require('os');
const fs = require('fs');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const touch = require('touch');
const si = require('systeminformation');
const camelcaseKeys = require('camelcase-keys').default;
const { version } = require('../../package.json');
const BasePlugin = require('./base');
const FileWatcher = require('../utils/file_watcher');
let i2c;
try {
	({ I2C } = require('raspi-i2c'));
	i2c = new I2C();
} catch (error) {
	i2c = false;
}

class HostPlugin extends BasePlugin {
	#powerSourceWatcher = undefined;
	#upgradeLogsWatcher = undefined;
	#upgradePidFile = '/var/www/virgo-api/upgrade.pid';
	#upgradeFile = '/var/www/virgo-api/upgrade.log';
	#upgradePid = null;
	#checkUpgradeIntervalId = null;

	constructor(io) {
		super(io, 'host');
		this.#watchPowerSource();
		this.#scheduleUpdatesChecker();
		this.#scheduleUpsChecker();
		
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
		this.#checkUps();
		this.#checkUpgrade(socket);

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
			this.#checkForUpdates();
		}
		if (this.getState('cpuStats')) {
			this.getNsp().emit('host:cpu:stats', this.getState('cpuStats'));
		} else {
			this.#pollCpuStats(socket);
		}
		if (this.getState('memory')) {
			this.getNsp().emit('host:memory', this.getState('memory'));
		} else {
			this.#pollMemory(socket);
		}
		if (this.getState('storage')) {
			this.getNsp().emit('host:storage', this.getState('storage'));
		} else {
			this.#pollStorage(socket);
		}
		if (this.getState('drives')) {
			this.getNsp().emit('host:drives', this.getState('drives'));
		} else {
			this.#pollDrives(socket);
		}
		if (this.getState('networkStats')) {
			this.getNsp().emit('host:network:stats', this.getState('networkStats'));
		} else {
			this.#pollNetworkStats(socket);
		}
		if (this.getState('ups')) {
			this.getNsp().emit('host:ups', this.getState('ups'));
		}
		if (this.getState('time')) {
			this.getNsp().emit('host:time', this.getState('time'));
		} else {
			this.#pollTime(socket);
		}

		socket.on('host:updates:check', () => { this.#checkUpdates(socket); });
		socket.on('host:upgrade', () => { this.#upgrade(socket); });
		socket.on('host:upgrade:complete', () => { this.#completeUpgrade(socket); });
		socket.on('host:reboot', () => { this.#reboot(socket); });
		socket.on('host:shutdown', () => { this.#shutdown(socket); });
	}

	async processJob(job) {
		if (job.name === 'updates:check') {
			return await this.#checkForUpdates();
		}
		if (job.name === 'ups:check') {
			return await this.#checkUps();
		}
	}

	#watchPowerSource() {
		const readFile = () => {
			let data = fs.readFileSync('/tmp/ups_power_source', { encoding: 'utf8', flag: 'r' });
			data = data.trim();
			if (data !== '') {
				if (this.getState('ups') === undefined) {
					this.setState('ups', {});
				}
				this.setState('ups', { ...this.getState('ups'), powerSource: data });
				this.getNsp().emit('host:ups', this.getState('ups'));
			}
		};

		if (i2c === false) {
			return;
		}
	
		if (this.#powerSourceWatcher) {
			return;
		}
	
		if (!fs.existsSync('/tmp/ups_power_source')) {
			touch.sync('/tmp/ups_power_source');
		}
	
		readFile();
	
		this.#powerSourceWatcher = new FileWatcher('/tmp/ups_power_source');
		this.#powerSourceWatcher
			.onChange((event, path) => {
				readFile();
			});
	}

	async #scheduleUpdatesChecker() {
		this.addJobSchedule(
			'updates:check',
			{ pattern: '0 0 0 * * *' }
		);
	}
	
	async #scheduleUpsChecker() {
		if (i2c === false) {
			return;
		}

		this.addJobSchedule(
			'ups:check',
			{ pattern: '0 * * * * *' }
		);
	}

	async #checkForUpdates() {
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

	async #checkUps() {
		if (i2c === false) {
			this.getNsp().emit('host:ups', this.getState('ups'));
			return;
		}
	
		if (this.getState('ups') === undefined) {
			this.setState('ups', {});
		}
	
		let batteryCharge;
		try {
			batteryCharge = i2c.readByteSync(0x36, 4);
		} catch (error) {
			batteryCharge = false;
		}
		this.setState('ups', { ...this.getState('ups'), batteryCharge });
		
		this.getNsp().emit('host:ups', this.getState('ups'));
	}

	#checkUpgrade(socket) {
		if (!fs.existsSync(this.#upgradePidFile)) {
			touch.sync(this.#upgradePidFile);
		}
		let data = fs.readFileSync(this.#upgradePidFile, { encoding: 'utf8', flag: 'r' });
		data = data.trim();
		if (data === '') {
			this.#upgradePid = null;
			this.setState('upgrade', undefined);
			this.getNsp().emit('host:upgrade', null);
			return;
		}
	
		this.#upgradePid = parseInt(data, 10);
	
		this.#watchUpgradeLog();
	
		if (this.#checkUpgradeIntervalId !== null) {
			return;
		}
	
		this.#checkUpgradeIntervalId = setInterval(async () => {
			if (this.#isUpgradeInProgress()) {
				return;
			}
	
			clearInterval(this.#checkUpgradeIntervalId);
			this.#checkUpgradeIntervalId = null;
			await this.#upgradeLogsWatcher?.stop();
			this.#upgradeLogsWatcher = undefined;
			this.setState('upgrade', { ...this.getState('upgrade'), state: 'succeeded' });
			this.getNsp().emit('host:upgrade', this.getState('upgrade'));
			this.#updates(socket);
		}, 1000);
	}

	async #checkUpdates(socket) {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
	
		if (this.getState('checkUpdates')) {
			return;
		}
	
		this.setState('checkUpdates', true);
		this.getNsp().to(`user:${socket.username}`).emit('host:updates:check', this.getState('checkUpdates'));
		try {
			await exec('apt update --allow-releaseinfo-change');
			this.setState('checkUpdates', false);
			this.#updates(socket);
		} catch (error) {
			this.setState('checkUpdates', false);
			this.getNsp().to(`user:${socket.username}`).emit('host:updates:check', this.getState('checkUpdates'));
		}
	}

	async #upgrade(socket) {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
	
		if (this.#upgradePid !== null) {
			return;
		}
	
		this.setState('upgrade', {
			state: 'running',
			steps: []
		});
	
		this.#watchUpgradeLog();
	
		try {
			await exec(`systemd-run --unit=upgrade-system --description="System upgrade" --wait --collect --setenv=DEBIAN_FRONTEND=noninteractive bash -c "echo $$ > ${this.#upgradePidFile}; apt-get dist-upgrade -y -q -o Dpkg::Options::='--force-confold' --auto-remove > /var/www/virgo-api/upgrade.log 2>&1"`);
			this.#checkUpgrade(socket);
		} catch (error) {
			await this.#upgradeLogsWatcher?.stop();
			this.#upgradeLogsWatcher = undefined;
			clearInterval(this.#checkUpgradeIntervalId);
			this.#checkUpgradeIntervalId = null;
			this.setState('upgrade', { ...this.getState('upgrade'), state: 'failed' });
			this.getNsp().emit('host:upgrade', this.getState('upgrade'));
			this.#updates(socket);
		};
	}

	#completeUpgrade(socket) {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		
		this.setState('upgrade', undefined);
		this.#upgradePid = null;
		fs.closeSync(fs.openSync(this.#upgradePidFile, 'w'));
		fs.closeSync(fs.openSync(this.#upgradeFile, 'w'));
		this.getNsp().emit('host:upgrade', null);
	}

	async #reboot(socket) {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
	
		if (this.getState('reboot') !== undefined) {
			return;
		}
	
		try {
			await exec('reboot');
			this.setState('reboot', true);
		} catch (error) {
			this.setState('reboot', false);
		}
	
		this.getNsp().emit('host:reboot', this.getState('reboot'));
	}
	
	async #shutdown(socket) {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
	
		if (this.getState('shutdown') !== undefined) {
			return;
		}
	
		try {
			await exec('shutdown -h now');
			this.setState('shutdown', true);
		} catch (error) {
			this.setState('shutdown', false);
		}
	
		this.getNsp().emit('host:shutdown', this.getState('shutdown'));
	}

	#isUpgradeInProgress() {
		try {
			process.kill(this.#upgradePid, 0);
			return true;
		} catch (error) {
			return false;
		}
	}

	#watchUpgradeLog() {
		const readFile = () => {
			let data = fs.readFileSync(this.#upgradeFile, { encoding: 'utf8', flag: 'r' });
			data = data.trim();
			if (data !== '') {
				this.setState('upgrade', { ...this.getState('upgrade'), steps: data.split('\n') });
				this.getNsp().emit('host:upgrade', this.getState('upgrade'));
			}
		};
	
		if (this.#upgradeLogsWatcher) {
			return;
		}
	
		if (!fs.existsSync(this.#upgradeFile)) {
			touch.sync(this.#upgradeFile);
		}
	
		if (this.getState('upgrade') === undefined) {
			this.setState('upgrade', {
				state: 'running',
				steps: []
			});
			readFile();
		}
	
		this.#upgradeLogsWatcher = new FileWatcher(this.#upgradeFile);
		this.#upgradeLogsWatcher
			.onChange((event, path) => {
				readFile();
			});
	}

	#updates(socket) {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			this.getNsp().to(`user:${socket.username}`).emit('host:updates', false);
			return;
		}
	
		if (this.#upgradePid === null) {
			this.getNsp().emit('host:upgrade', null);
		}
		this.#checkForUpdates();
	}

	async #pollCpuStats(socket) {
		if (this.getNsp().server.engine.clientsCount === 0) {
			this.setState('cpuStats', undefined);
			return;
		}
	
		try {
			const currentLoad = await si.currentLoad();
			const cpuTemperature = await si.cpuTemperature();
			const fan = await exec('cat /sys/devices/platform/cooling_fan/hwmon/hwmon*/fan1_input || true');
			this.setState('cpuStats', { ...currentLoad, temperature: cpuTemperature, fan: (fan.stdout ? fan.stdout.trim() : '') });
		} catch (error) {
			this.setState('cpuStats', false);
		}
	
		this.getNsp().emit('host:cpu:stats', this.getState('cpuStats'));
		setTimeout(() => { this.#pollCpuStats(socket); }, 5000);
	}
	
	async #pollMemory(socket) {
		if (this.getNsp().server.engine.clientsCount === 0) {
			this.setState('memory', undefined);
			return;
		}
	
		try {
			const memory = await si.mem();
			this.setState('memory', memory);
		} catch (error) {
			this.setState('memory', false);
		}
	
		this.getNsp().emit('host:memory', this.getState('memory'));
		setTimeout(() => { this.#pollMemory(socket); }, 10000);
	}
	
	async #pollStorage(socket) {
		if (this.getNsp().server.engine.clientsCount === 0) {
			this.setState('storage', undefined);
			return;
		}
	
		try {
			const poolsList = await exec('zpool list -jp --json-int | jq');
			const poolsStatus = await exec('zpool status -jp --json-int | jq');
			const filesystems = await si.fsSize();
			const pools = JSON.parse(poolsStatus.stdout).pools;
			let storage = Object.values(JSON.parse(poolsList.stdout).pools).map((pool) => {
				return { ...pool, ...pools[pool.name] };
			});
			let filesystem = filesystems.find((filesystem) => {
				return filesystem.mount === '/';
			});
			if (filesystem) {
				let pool = {
					name: 'system',
					properties: {
						health: {
							value: 'ONLINE'
						},
						size: {
							value: filesystem.size
						},
						allocated: {
							value: filesystem.used
						},
						free: {
							value: filesystem.available
						},
						capacity: {
							value: filesystem.use
						}
					}
				}
				storage.push(pool);
			}
			storage = camelcaseKeys(storage, { deep: true });
			this.setState('storage', storage);
		} catch (error) {
			this.setState('storage', false);
		}
	
		this.getNsp().emit('host:storage', this.getState('storage'));
		setTimeout(() => { this.#pollStorage(socket); }, 60000);
	}
	
	async #pollDrives(socket) {
		if (this.getNsp().server.engine.clientsCount === 0) {
			this.setState('drives', undefined);
			return;
		}
	
		try {
			const responseSmartctl = await exec(`smartctl --scan | awk '{print $1}' | xargs -I {} smartctl -a -j {} | jq -s .`);
			const responseNvme = await exec(`smartctl --scan | awk '{print $1}' | xargs -I {} nvme id-ctrl -o json {} | jq -s '[.[] | {wctemp: (.wctemp - 273), cctemp: (.cctemp - 273)}]'`);
			let drives = JSON.parse(responseSmartctl.stdout);
			let nvme = JSON.parse(responseNvme.stdout);
			this.setState('drives', drives.map((drive, index) => {
				return {
					name: drive.device.name,
					model: drive.model_name,
					serialNumber: drive.serial_number,
					capacity: drive.user_capacity,
					temperature: drive.temperature.current,
					temperatureWarningThreshold: (nvme.length > 0 ? nvme[index]?.wctemp : 99),
					temperatureCriticalThreshold: (nvme.length > 0 ? nvme[index]?.cctemp: 99)
				};
			}));
		} catch (error) {
			this.setState('drives', false);
		}
	
		this.getNsp().emit('host:drives', this.getState('drives'));
		setTimeout(() => { this.#pollDrives(socket); }, 60000);
	}
	
	async #pollNetworkStats(socket) {
		if (this.getNsp().server.engine.clientsCount === 0) {
			this.setState('networkStats', undefined);
			return;
		}
	
		try {
			const networkStats = await si.networkStats();
			let networkInterfaceStats = networkStats[0];
			if (networkInterfaceStats.rx_sec === null) {
				networkInterfaceStats.rx_sec = 0;
			}
			if (networkInterfaceStats.tx_sec === null) {
				networkInterfaceStats.tx_sec = 0;
			}
			this.setState('networkStats', networkInterfaceStats);
		} catch (error) {
			this.setState('networkStats', false);
		}
	
		this.getNsp().emit('host:network:stats', this.getState('networkStats'));
		setTimeout(() => { this.#pollNetworkStats(socket); }, 2000);
	}
	
	#pollTime(socket) {
		if (this.getNsp().server.engine.clientsCount === 0) {
			this.setState('time', undefined);
			return;
		}
	
		this.setState('time', si.time());
		this.getNsp().emit('host:time', this.getState('time'));
		setTimeout(() => { this.#pollTime(socket); }, 60000);
	}
}

module.exports = (io) => {
	return new HostPlugin(io);
};
