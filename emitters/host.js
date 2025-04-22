const os = require('os');
const fs = require('fs');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const touch = require('touch');
const si = require('systeminformation');
const camelcaseKeys = require('camelcase-keys').default;
const { version } = require('../package.json');
let i2c = false;
try {
	({ I2C } = require('raspi-i2c'));
	i2c = new I2C();
} catch (error) { }

let nsp;
let state = {};
let timeouts = {};
let upgradePid = null;
let upgradeLogsWatcher = null;
let checkUpgeadeIntervalId = null;
let powerSourceWatcher = null;
const upgradePidFile = '/var/www/virgo-api/upgrade.pid';
const upgradeFile = '/var/www/virgo-api/upgrade.log';

state.system = {
	api: {
		version
	}
};
si.system((system) => {
	state.system = { ...state.system, ...system };
});
si.osInfo((osInfo) => {
	let stdout = childProcess.execSync('hostname -f 2>/dev/null');
	osInfo.fqdn = stdout.toString().split(os.EOL)[0]
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

const reboot = (socket) => {
	if (!socket.isAuthenticated) {
		return;
	}

	if (state.reboot !== undefined) {
		return;
	}

	exec('reboot')
		.then((response) => {
			state.reboot = true;
		})
		.catch((error) => {
			state.reboot = false;
		})
		.then(() => {
			nsp.emit('reboot', state.reboot);
		});
};

const shutdown = (socket) => {
	if (!socket.isAuthenticated) {
		return;
	}

	if (state.shutdown !== undefined) {
		return;
	}

	exec('shutdown -h now')
		.then((response) => {
			state.shutdown = true;
		})
		.catch((error) => {
			state.shutdown = false;
		})
		.then(() => {
			nsp.emit('shutdown', state.shutdown);
		});
};

const checkUpdates = (socket) => {
	if (!socket.isAuthenticated) {
		return;
	}

	if (state.checkUpdates) {
		return;
	}

	state.checkUpdates = true;
	nsp.to(`user:${socket.user}`).emit('checkUpdates', state.checkUpdates);
	exec('apt update --allow-releaseinfo-change')
		.then(() => {
			state.checkUpdates = false;
			updates(socket);
		});
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
	if (upgradeLogsWatcher !== null) {
		return;
	}

	touch.sync(upgradeFile);

	if (state.upgrade === undefined) {
		state.upgrade = {
			state: 'running',
			steps: []
		};
		readUpgradeLog();
	}

	upgradeLogsWatcher = fs.watch(upgradeFile, (eventType) => {
		if (eventType === 'change') {
			readUpgradeLog();
		}
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
	touch.sync(upgradePidFile);
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

	checkUpgeadeIntervalId = setInterval(() => {
		if (isUpgradeInProgress()) {
			return;
		}

		clearInterval(checkUpgeadeIntervalId);
		checkUpgeadeIntervalId = null;
		upgradeLogsWatcher?.close();
		upgradeLogsWatcher = null;
		state.upgrade.state = 'succeeded';
		nsp.emit('upgrade', state.upgrade);
		updates(socket);
	}, 1000);
};

const upgrade = (socket) => {
	if (!socket.isAuthenticated) {
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

	exec(`systemd-run --unit=upgrade-system --description="System upgrade" --wait --collect --setenv=DEBIAN_FRONTEND=noninteractive bash -c "echo $$ > ${upgradePidFile}; apt-get dist-upgrade -o Dpkg::Options::='--force-confold' -y -q > /var/www/virgo-api/upgrade.log 2>&1"`)
		.then(() => {
			checkUpgrade(socket);
		})
		.catch((error) => {
			upgradeLogsWatcher?.close();
			upgradeLogsWatcher = null;
			clearInterval(checkUpgeadeIntervalId);
			checkUpgeadeIntervalId = null;
			state.upgrade.state = 'failed';
			nsp.emit('upgrade', state.upgrade);
			updates(socket);
		});
};

const completeUpgrade = (socket) => {
	if (!socket.isAuthenticated) {
		return;
	}

	delete state.upgrade;
	upgradePid = null;
	fs.closeSync(fs.openSync(upgradePidFile, 'w'));
	fs.closeSync(fs.openSync(upgradeFile, 'w'));
	nsp.emit('upgrade', null);
};

const updates = (socket) => {
	if (!socket.isAuthenticated) {
		nsp.to(`user:${socket.user}`).emit('updates', false);
		return;
	}

	if (upgradePid === null) {
		nsp.emit('upgrade', null);
	}
	clearTimeout(timeouts.updates);
	delete timeouts.updates;
	pollUpdates(socket);
};

const pollUpdates = (socket) => {
	state.updates = [];

	exec('apt-show-versions -u')
		.then((response) => {
			let updates = response.stdout.trim();
			if (updates === '') {
				return;
			}
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
		})
		.catch((error) => {
			state.updates = false;
		})
		.then(() => {
			nsp.to(`user:${socket.user}`).emit('updates', state.updates);
			nsp.to(`user:${socket.user}`).emit('checkUpdates', state.checkUpdates);
			timeouts.updates = setTimeout(pollUpdates.bind(null, socket), 3600000);
		});
};

const pollCpuStats = (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.cpuStats;
		return;
	}

	state.cpuStats = {};

	Promise.all([
		si.currentLoad(),
		si.cpuTemperature(),
		exec('cat /sys/devices/platform/cooling_fan/hwmon/hwmon*/fan1_input || true')
	])
		.then(([currentLoad, cpuTemperature, fan]) => {
			state.cpuStats = { ...currentLoad, temperature: cpuTemperature, fan: (fan.stdout ? fan.stdout.trim() : '') };

		})
		.catch((error) => {
			state.cpuStats = false;
		})
		.then(() => {
			nsp.emit('cpuStats', state.cpuStats);
			setTimeout(pollCpuStats.bind(null, socket), 5000);
		});
};

const pollMemory = (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.memory;
		return;
	}

	state.memory = {};

	si.mem()
		.then((memory) => {
			state.memory = memory;
		})
		.catch((error) => {
			state.memory = false;
		})
		.then(() => {
			nsp.emit('memory', state.memory);
			setTimeout(pollMemory.bind(null, socket), 10000);
		});
};

const pollStorage = (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.storage;
		return;
	}

	state.storage = [];

	Promise.all([
		exec('zpool list -jp --json-int | jq'),
		exec('zpool status -jp --json-int | jq'),
		si.fsSize()
	])
		.then(([poolsList, poolsStatus, filesystems]) => {
			poolsStatus = JSON.parse(poolsStatus.stdout).pools;
			let storage = Object.values(JSON.parse(poolsList.stdout).pools).map((pool) => {
				return { ...pool, ...poolsStatus[pool.name] };
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
		})
		.catch((error) => {
			state.storage = false;
		})
		.then(() => {
			nsp.emit('storage', state.storage);
			setTimeout(pollStorage.bind(null, socket), 60000);
		});
};

const pollDrives = (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.drives;
		return;
	}

	state.drives = [];
	Promise.all([
		exec(`smartctl --scan | awk '{print $1}' | xargs -I {} smartctl -a -j {} | jq -s .`),
		exec(`smartctl --scan | awk '{print $1}' | xargs -I {} nvme id-ctrl -o json {} | jq -s '[.[] | {wctemp: (.wctemp - 273), cctemp: (.cctemp - 273)}]'`)
	])
		.then(([responseSmartctl, responseNvme]) => {
			let drives = JSON.parse(responseSmartctl.stdout);
			let nvme = JSON.parse(responseNvme.stdout);
			state.drives = drives.map((drive, index) => {
				return {
					name: drive.device.name,
					model: drive.model_name,
					serialNumber: drive.serial_number,
					capcity: drive.user_capacity,
					temperature: drive.temperature.current,
					temperatureWarningThreshold: nvme[index].wctemp,
					temperatureCriticalThreshold: nvme[index].cctemp
				};
			});
		})
		.catch((error) => {
			state.drives = false;
		})
		.then(() => {
			nsp.emit('drives', state.drives);
			setTimeout(pollDrives.bind(null, socket), 60000);
		});
};

const pollNetworkStats = (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.networkStats;
		return;
	}

	state.networkStats = {};

	si.networkStats()
		.then((networkStats) => {
			let networkInterfaceStats = networkStats[0];
			if (networkInterfaceStats.rx_sec === null) {
				networkInterfaceStats.rx_sec = 0;
			}
			if (networkInterfaceStats.tx_sec === null) {
				networkInterfaceStats.tx_sec = 0;
			}
			state.networkStats = networkInterfaceStats;
		})
		.catch((error) => {
			state.networkStats = false;
		})
		.then(() => {
			nsp.emit('networkStats', state.networkStats);
			setTimeout(pollNetworkStats.bind(null, socket), 2000);
		});
};

const watchPowerSource = () => {
	if (powerSourceWatcher !== null) {
		return;
	}

	touch.sync('/tmp/ups_power_source');

	readPowerSource();

	powerSourceWatcher = fs.watch('/tmp/ups_power_source', (eventType) => {
		if (eventType === 'change') {
			readPowerSource();
		}
	});

	function readPowerSource() {
		let data = fs.readFileSync('/tmp/ups_power_source', { encoding: 'utf8', flag: 'r' });
		data = data.trim();
		if (data !== '') {
			state.ups.powerSource = data;
			nsp.emit('ups', state.ups);
		}
	}
};

const pollUps = (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		powerSourceWatcher?.close();
		powerSourceWatcher = null;
		delete state.ups;
		return;
	}

	if (i2c === false) {
		state.ups = 'remote i/o error';
		nsp.emit('ups', state.ups);
		return;
	}

	if (state.ups === undefined) {
		state.ups = {};
	}

	let batteryCharge;
	try {
		batteryCharge = i2c.readByteSync(0x36, 4);
	} catch (error) {
		state.ups.batteryCharge = false;
		nsp.emit('ups', state.ups);
		return;
	}

	watchPowerSource();

	state.ups.batteryCharge = batteryCharge;
	nsp.emit('ups', state.ups);
	setTimeout(pollUps.bind(null, socket), 60000);
};

const pollTime = (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.time;
		return;
	}

	state.time = si.time();
	nsp.emit('time', state.time);
	setTimeout(pollTime.bind(null, socket), 60000);
};

module.exports = (io) => {
	nsp = io.of('/host');
	nsp.use((socket, next) => {
		socket.isAuthenticated = (socket.handshake.headers['remote-user'] !== undefined);
		socket.user = (socket.isAuthenticated ? socket.handshake.headers['remote-user'] : 'guest');
		next();
	});
	nsp.on('connection', (socket) => {
		socket.join(`user:${socket.user}`);

		checkUpgrade(socket);
		nsp.emit('system', state.system);
		if (state.reboot === undefined) {
			nsp.emit('reboot', false);
		}
		if (state.shutdown === undefined) {
			nsp.emit('shutdown', false);
		}
		if (state.checkUpdates) {
			if (socket.isAuthenticated) {
				nsp.to(`user:${socket.user}`).emit('checkUpdates', state.checkUpdates);
			}
		}
		if (state.updates) {
			nsp.to(`user:${socket.user}`).emit('updates', (socket.isAuthenticated ? state.updates : []));
		} else {
			pollUpdates(socket);
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
		} else {
			pollUps(socket);
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
};
