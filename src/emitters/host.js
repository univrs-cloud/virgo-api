const os = require('os');
const fs = require('fs');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const touch = require('touch');
const si = require('systeminformation');
const camelcaseKeys = require('camelcase-keys').default;
const { version } = require('../../package.json');
const chokidar = require('chokidar');
const { Queue, Worker } = require('bullmq');
let i2c = false;
try {
	({ I2C } = require('raspi-i2c'));
	i2c = new I2C();
} catch (error) { }

let nsp;
let state = {};
let upgradePid = null;
let checkUpgeadeIntervalId = null;
let upgradeLogsWatcher;
let powerSourceWatcher;
const upgradePidFile = '/var/www/virgo-api/upgrade.pid';
const upgradeFile = '/var/www/virgo-api/upgrade.log';
const queue = new Queue('host-jobs');
const worker = new Worker(
	'host-jobs',
	async (job) => {
		if (job.name === 'checkForUpdates') {
			return await checkForUpdates();
		}
		if (job.name === 'checkUps') {
			return await checkUps();
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

const scheduleUpdatesChecker = async () => {
	try {
		await queue.upsertJobScheduler(
			'updatesChecker',
			{ pattern: '0 0 0 * * *' },
			{
				name: 'checkForUpdates',
				opts: {
					removeOnComplete: 1
				}
			}
		);
	} catch (error) {
		console.error('Error starting job:', error);
	};
};

const scheduleUpsChecker = async () => {
	try {
		await queue.upsertJobScheduler(
			'upsChecker',
			{ pattern: '0 * * * * *' },
			{
				name: 'checkUps',
				opts: {
					removeOnComplete: 1
				}
			}
		);
	} catch (error) {
		console.error('Error starting job:', error);
	};
};

state.system = {
	api: {
		version
	},
	zfs: {
		version: ''
	}
};
si.system((system) => {
	let stdout = childProcess.execSync('zfs version -j 2>/dev/null');
	let zfs = JSON.parse(stdout);
	state.system.zfs.version = zfs.zfs_version.kernel.replace('zfs-kmod-', '');
	state.system = { ...state.system, ...system };
});
si.osInfo((osInfo) => {
	let stdout = childProcess.execSync('hostname -f 2>/dev/null');
	osInfo.fqdn = stdout.toString().split(os.EOL)[0];
	state.system.osInfo = osInfo;
});
si.cpu((cpu) => {
	state.system.cpu = cpu;
});
si.networkGatewayDefault((defaultGateway) => {
	state.system.defaultGateway = defaultGateway;
});
si.networkInterfaces((networkInterface) => {
	state.system.networkInterface = networkInterface;
}, null, 'default');

const reboot = async (socket) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	if (state.reboot !== undefined) {
		return;
	}

	try {
		await exec('reboot');
		state.reboot = true;
	} catch (error) {
		state.reboot = false;
	}

	nsp.emit('reboot', state.reboot);
};

const shutdown = async (socket) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	if (state.shutdown !== undefined) {
		return;
	}

	try {
		await exec('shutdown -h now');
		state.shutdown = true;
	} catch (error) {
		state.shutdown = false;
	}

	nsp.emit('shutdown', state.shutdown);
};

const checkUpdates = async (socket) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	if (state.checkUpdates) {
		return;
	}

	state.checkUpdates = true;
	nsp.to(`user:${socket.username}`).emit('checkUpdates', state.checkUpdates);
	try {
		await exec('apt update --allow-releaseinfo-change');
		state.checkUpdates = false;
		updates(socket);
	} catch (error) {
		state.checkUpdates = false;
		nsp.to(`user:${socket.username}`).emit('checkUpdates', state.checkUpdates);
	}
};

const isUpgradeInProgress = (socket) => {
	try {
		process.kill(upgradePid, 0);
		return true;
	} catch (error) {
		return false;
	}
};

const watchUpgradeLog = () => {
	if (upgradeLogsWatcher) {
		return;
	}

	if (!fs.existsSync(upgradeFile)) {
		touch.sync(upgradeFile);
	}

	if (state.upgrade === undefined) {
		state.upgrade = {
			state: 'running',
			steps: []
		};
		readUpgradeLog();
	}

	upgradeLogsWatcher = chokidar.watch(upgradeFile, {
		persistent: true,
		ignoreInitial: true
	});
	upgradeLogsWatcher
		.on('all', (event, path) => {
			readUpgradeLog();
		})
		.on('error', (error) => {
			console.error(`Watcher error: ${error}`);
		});

	function readUpgradeLog() {
		let data = fs.readFileSync(upgradeFile, { encoding: 'utf8', flag: 'r' });
		data = data.trim();
		if (data !== '') {
			state.upgrade.steps = data.split('\n');
			nsp.emit('upgrade', state.upgrade);
		}
	}
}

const checkUpgrade = (socket) => {
	if (!fs.existsSync(upgradePidFile)) {
		touch.sync(upgradePidFile);
	}
	let data = fs.readFileSync(upgradePidFile, { encoding: 'utf8', flag: 'r' });
	data = data.trim();
	if (data === '') {
		upgradePid = null;
		delete state.upgrade;
		nsp.emit('upgrade', null);
		return;
	}

	upgradePid = parseInt(data, 10);

	watchUpgradeLog();

	if (checkUpgeadeIntervalId !== null) {
		return;
	}

	checkUpgeadeIntervalId = setInterval(async () => {
		if (isUpgradeInProgress()) {
			return;
		}

		clearInterval(checkUpgeadeIntervalId);
		checkUpgeadeIntervalId = null;
		await upgradeLogsWatcher?.close();
		upgradeLogsWatcher = undefined;
		state.upgrade.state = 'succeeded';
		nsp.emit('upgrade', state.upgrade);
		updates(socket);
	}, 1000);
};

const upgrade = async (socket) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	if (upgradePid !== null) {
		return;
	}

	state.upgrade = {
		state: 'running',
		steps: []
	};

	watchUpgradeLog();

	try {
		await exec(`systemd-run --unit=upgrade-system --description="System upgrade" --wait --collect --setenv=DEBIAN_FRONTEND=noninteractive bash -c "echo $$ > ${upgradePidFile}; apt-get dist-upgrade -y -q -o Dpkg::Options::='--force-confold' --auto-remove > /var/www/virgo-api/upgrade.log 2>&1"`);
		checkUpgrade(socket);
	} catch (error) {
		await upgradeLogsWatcher?.close();
		upgradeLogsWatcher = undefined;
		clearInterval(checkUpgeadeIntervalId);
		checkUpgeadeIntervalId = null;
		state.upgrade.state = 'failed';
		nsp.emit('upgrade', state.upgrade);
		updates(socket);
	};
};

const completeUpgrade = (socket) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	delete state.upgrade;
	upgradePid = null;
	fs.closeSync(fs.openSync(upgradePidFile, 'w'));
	fs.closeSync(fs.openSync(upgradeFile, 'w'));
	nsp.emit('upgrade', null);
};

const updates = (socket) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		nsp.to(`user:${socket.username}`).emit('updates', false);
		return;
	}

	if (upgradePid === null) {
		nsp.emit('upgrade', null);
	}
	checkForUpdates();
};

const checkForUpdates = async () => {
	try {
		const response = await exec('apt-show-versions -u');
		let updates = response.stdout.trim();
		if (updates !== '') {
			state.updates = updates.split('\n').map((line) => {
				let parts = line.split(' ');
				return {
					package: parts[0].split(':')[0],
					version: {
						installed: parts[1].split('~')[0],
						upgradableTo: parts[4].split('~')[0]
					}
				};
			});
		} else {
			state.updates = [];
		}
	} catch (error) {
		state.updates = false;
	}

	for (const socket of nsp.sockets.values()) {
		if (socket.isAuthenticated && socket.isAdmin) {
			nsp.to(`user:${socket.username}`).emit('checkUpdates', state.checkUpdates);
			nsp.to(`user:${socket.username}`).emit('updates', state.updates);
		}
	};
	return ``;
};

const pollCpuStats = async (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.cpuStats;
		return;
	}

	try {
		const currentLoad = await si.currentLoad();
		const cpuTemperature = await si.cpuTemperature();
		const fan = await exec('cat /sys/devices/platform/cooling_fan/hwmon/hwmon*/fan1_input || true');
		state.cpuStats = { ...currentLoad, temperature: cpuTemperature, fan: (fan.stdout ? fan.stdout.trim() : '') };
	} catch (error) {
		state.cpuStats = false;
	}

	nsp.emit('cpuStats', state.cpuStats);
	setTimeout(() => { pollCpuStats(socket); }, 5000);
};

const pollMemory = async (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.memory;
		return;
	}

	try {
		const memory = await si.mem();
		state.memory = memory;
	} catch (error) {
		state.memory = false;
	}

	nsp.emit('memory', state.memory);
	setTimeout(() => { pollMemory(socket); }, 10000);
};

const pollStorage = async (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.storage;
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
		state.storage = storage;
	} catch (error) {
		state.storage = false;
	}

	nsp.emit('storage', state.storage);
	setTimeout(() => { pollStorage(socket); }, 60000);
};

const pollDrives = async (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.drives;
		return;
	}

	try {
		const responseSmartctl = await exec(`smartctl --scan | awk '{print $1}' | xargs -I {} smartctl -a -j {} | jq -s .`);
		const responseNvme = await exec(`smartctl --scan | awk '{print $1}' | xargs -I {} nvme id-ctrl -o json {} | jq -s '[.[] | {wctemp: (.wctemp - 273), cctemp: (.cctemp - 273)}]'`);
		let drives = JSON.parse(responseSmartctl.stdout);
		let nvme = JSON.parse(responseNvme.stdout);
		state.drives = drives.map((drive, index) => {
			return {
				name: drive.device.name,
				model: drive.model_name,
				serialNumber: drive.serial_number,
				capcity: drive.user_capacity,
				temperature: drive.temperature.current,
				temperatureWarningThreshold: (nvme.length > 0 ? nvme[index]?.wctemp : 99),
				temperatureCriticalThreshold: (nvme.length > 0 ? nvme[index]?.cctemp: 99)
			};
		});
	} catch (error) {
		state.drives = false;
	}

	nsp.emit('drives', state.drives);
	setTimeout(() => { pollDrives(socket); }, 60000);
};

const pollNetworkStats = async (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.networkStats;
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
		state.networkStats = networkInterfaceStats;
	} catch (error) {
		state.networkStats = false;
	}

	nsp.emit('networkStats', state.networkStats);
	setTimeout(() => { pollNetworkStats(socket); }, 2000);
};

const watchPowerSource = () => {
	if (i2c === false) {
		return;
	}

	if (powerSourceWatcher) {
		return;
	}

	if (!fs.existsSync('/tmp/ups_power_source')) {
		touch.sync('/tmp/ups_power_source');
	}

	readPowerSource();

	powerSourceWatcher = chokidar.watch('/tmp/ups_power_source', {
		persistent: true,
		ignoreInitial: true
	});
	powerSourceWatcher
		.on('all', (event, path) => {
			readPowerSource();
		})
		.on('error', (error) => {
			console.error(`Watcher error: ${error}`);
		});

	function readPowerSource() {
		let data = fs.readFileSync('/tmp/ups_power_source', { encoding: 'utf8', flag: 'r' });
		data = data.trim();
		if (data !== '') {
			if (state.ups === undefined) {
				state.ups = {};
			}
			state.ups.powerSource = data;
			nsp.emit('ups', state.ups);
		}
	}
};

const checkUps = async () => {
	if (i2c === false) {
		state.ups = 'remote i/o error';
		nsp.emit('ups', state.ups);
		return;
	}

	if (state.ups === undefined) {
		state.ups = {};
	}

	try {
		state.ups.batteryCharge = i2c.readByteSync(0x36, 4);
	} catch (error) {
		state.ups.batteryCharge = false;
	}
	
	nsp.emit('ups', state.ups);
};

const pollTime = (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.time;
		return;
	}

	state.time = si.time();
	nsp.emit('time', state.time);
	setTimeout(() => { pollTime(socket); }, 60000);
};

scheduleUpdatesChecker();
scheduleUpsChecker();

module.exports = (io) => {
	nsp = io.of('/host');
	nsp.use((socket, next) => {
		socket.isAuthenticated = (socket.handshake.headers['remote-user'] !== undefined);
		socket.isAdmin = (socket.isAuthenticated ? socket.handshake.headers['remote-groups']?.split(',')?.includes('admins') : false);
		socket.username = (socket.isAuthenticated ? socket.handshake.headers['remote-user'] : 'guest');
		next();
	});
	nsp.on('connection', (socket) => {
		socket.join(`user:${socket.username}`);

		checkUpgrade(socket);

		nsp.emit('system', state.system);
		if (state.reboot === undefined) {
			nsp.emit('reboot', false);
		}
		if (state.shutdown === undefined) {
			nsp.emit('shutdown', false);
		}
		if (state.checkUpdates) {
			if (socket.isAuthenticated && socket.isAdmin) {
				nsp.to(`user:${socket.username}`).emit('checkUpdates', state.checkUpdates);
			}
		}
		if (state.updates) {
			nsp.to(`user:${socket.username}`).emit('updates', (socket.isAuthenticated && socket.isAdmin ? state.updates : []));
		} else {
			checkForUpdates();
		}
		if (state.cpuStats) {
			nsp.emit('cpuStats', state.cpuStats);
		} else {
			pollCpuStats(socket);
		}
		if (state.memory) {
			nsp.emit('memory', state.memory);
		} else {
			pollMemory(socket);
		}
		if (state.storage) {
			nsp.emit('storage', state.storage);
		} else {
			pollStorage(socket);
		}
		if (state.drives) {
			nsp.emit('drives', state.drives);
		} else {
			pollDrives(socket);
		}
		if (state.networkStats) {
			nsp.emit('networkStats', state.networkStats);
		} else {
			pollNetworkStats(socket);
		}
		if (state.ups) {
			nsp.emit('ups', state.ups);
		}
		if (state.time) {
			nsp.emit('time', state.time);
		} else {
			pollTime(socket);
		}

		socket.on('checkUpdates', () => { checkUpdates(socket); });
		socket.on('upgrade', () => { upgrade(socket); });
		socket.on('completeUpgrade', () => { completeUpgrade(socket); });
		socket.on('reboot', () => { reboot(socket); });
		socket.on('shutdown', () => { shutdown(socket); });

		socket.on('disconnect', () => {
			//
		});
	});

	watchPowerSource();
	checkUps();
};
