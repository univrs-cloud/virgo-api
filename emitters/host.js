const os = require('os');
const fs = require('fs');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const touch = require('touch');
const { Sequelize, DataTypes } = require('sequelize');
const si = require('systeminformation');
const { zpool } = require('@univrs/zfs');
let i2c = false;
try {
	({ I2C } = require('raspi-i2c'));
	i2c = new I2C();
} catch (error) {}

const sequelize = new Sequelize({
	dialect: 'sqlite',
	storage: '/messier/apps/nginx-proxy-manager/data/database.sqlite',
	define: {
		timestamps: false
	},
	logging: false
});
const ProxyHost = sequelize.define(
	'ProxyHost',
	{
		enabled: DataTypes.BOOLEAN,
		isDeleted: DataTypes.BOOLEAN,
		domainNames: DataTypes.JSON,
		sslForced: DataTypes.BOOLEAN,
		forwardScheme: DataTypes.STRING,
		forwardHost: DataTypes.STRING,
		forwardPort: DataTypes.INTEGER
	},
	{
		tableName: 'proxy_host',
		underscored: true
	}
);

let nsp;
let state = {};
let timeouts = {};
let upgradePid = null;
let upgradePidFile = '/var/www/virgo-api/upgrade.pid';
let upgradeFile = '/var/www/virgo-api/upgrade.log';
let upgradeLogsWatcher = null;
let checkUpgeadeIntervalId = null;
let powerSourceWatcher = null;

state.system = {};
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
	exec('apt update')
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

	exec(`systemd-run --unit=upgrade-system --description="System upgrade" --wait --collect --setenv=DEBIAN_FRONTEND=noninteractive bash -c "echo $$ > ${upgradePidFile}; apt-get upgrade --with-new-pkgs -o Dpkg::Options::='--force-confold' -y -q > /var/www/virgo-api/upgrade.log 2>&1"`)
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

const pollProxies = (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.proxies;
		return;
	}

	state.proxies = [];

	ProxyHost.findAll({
		where: {
			isDeleted: false
		}
	})
	 	.then((proxies) => {
			state.proxies = proxies;
		})
		.catch((error) => {
			state.proxies = false;
		})
		.then(() => {
			nsp.emit('proxies', state.proxies);
			setTimeout(pollProxies.bind(null, socket), 3600000);
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
		new Promise((resolve, reject) => {
			let pools;
			zpool.list((error, response) => {
				if (error) {
					return reject(error);
				}

				pools = response;
				
				zpool.status((error, response) => {
					if (error) {
						console.log('error', error);
						return resolve(pools);
					}

					pools = pools.map((pool) => {
						const status = response.find((obj) => { return obj.name === pool.name; });
						return (status ? { ...pool, ...status } : pool);
					});
					resolve(pools);
				});
			});
		}),
		si.fsSize()
	])
		.then(([pools, filesystems]) => {
			let filesystem = filesystems.find((filesystem) => {
				return filesystem.mount === '/';
			});
			if (filesystem) {
				let pool = {
					name: 'system',
					size: filesystem.size,
					alloc: filesystem.used,
					free: filesystem.available,
					cap: filesystem.use,
					health: 'ONLINE'
				}
				pools.push(pool);
			}
			let storage = pools.map((pool) => {
				pool.size = Number.parseInt(pool.size);
				pool.alloc = Number.parseInt(pool.alloc);
				pool.free = Number.parseInt(pool.free);
				pool.cap = Number.parseFloat(pool.cap);
				return pool;
			});
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
		exec("smartctl --scan | awk '{print $1}' | xargs -I {} smartctl -a -j {} | jq -s ."),
		exec("smartctl --scan | awk '{print $1}' | xargs -I {} nvme id-ctrl -o json {} | jq -s '[.[] | {wctemp: (.wctemp - 273), cctemp: (.cctemp - 273)}]'")
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
		if (state.proxies) {
			nsp.emit('proxies', state.proxies);
		} else {
			pollProxies(socket);
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

// zpool status
//   pool: messier
//  state: DEGRADED
// status: One or more devices is currently being resilvered.  The pool will
// 	continue to function, possibly in a degraded state.
// action: Wait for the resilver to complete.
//   scan: resilver in progress since Mon Feb  3 19:04:33 2025
// 	114G / 114G scanned, 535M / 114G issued at 178M/s
// 	538M resilvered, 0.46% done, 00:10:52 to go
// config:

// 	NAME                                             STATE     READ WRITE CKSUM
// 	messier                                          DEGRADED     0     0     0
// 	  mirror-0                                       DEGRADED     0     0     0
// 	    nvme-eui.00000000000000000026b738336717b5    ONLINE       0     0     0
// 	    replacing-1                                  DEGRADED     0     0     0
// 	      14055708554257071460                       UNAVAIL      0     0     0  was /dev/disk/by-id/nvme-eui.00000000000000000026b73833673485-part1
// 	      nvme-eui.00000000000000000000000000002092  ONLINE       0     0     0  (resilvering)

// errors: No known data errors

// zpool status
//   pool: messier
//  state: DEGRADED
// status: One or more devices is currently being resilvered.  The pool will
// 	continue to function, possibly in a degraded state.
// action: Wait for the resilver to complete.
//   scan: resilver in progress since Mon Feb  3 19:20:21 2025
// 	114G / 114G scanned, 1.39G / 114G issued at 238M/s
// 	1.40G resilvered, 1.22% done, 00:08:05 to go
// config:

// 	NAME                                             STATE     READ WRITE CKSUM
// 	messier                                          DEGRADED     0     0     0
// 	  mirror-0                                       DEGRADED     0     0     0
// 	    replacing-0                                  DEGRADED     0     0     0
// 	      3237883490408593218                        UNAVAIL      0     0     0  was /dev/disk/by-id/nvme-eui.00000000000000000026b738336717b5-part1
// 	      nvme-eui.000000000000000000000000020929ae  ONLINE       0     0     0  (resilvering)
// 	    nvme-eui.00000000000000000000000000002092    ONLINE       0     0     0

// errors: No known data errors

// zpool status
//   pool: messier
//  state: ONLINE
//   scan: resilvered 114G in 00:06:07 with 0 errors on Mon Feb  3 19:10:40 2025
// config:

// 	NAME                                           STATE     READ WRITE CKSUM
// 	messier                                        ONLINE       0     0     0
// 	  mirror-0                                     ONLINE       0     0     0
// 	    nvme-eui.00000000000000000026b738336717b5  ONLINE       0     0     0
// 	    nvme-eui.00000000000000000000000000002092  ONLINE       0     0     0

// errors: No known data errors

// zpool status
//   pool: messier
//  state: ONLINE
//   scan: scrub in progress since Sat Feb 15 18:05:08 2025
// 	116G / 116G scanned, 521M / 116G issued at 260M/s
// 	0B repaired, 0.44% done, 00:07:33 to go
// config:

// 	NAME                                           STATE     READ WRITE CKSUM
// 	messier                                        ONLINE       0     0     0
// 	  mirror-0                                     ONLINE       0     0     0
// 	    nvme-eui.000000000000000000000000020929ae  ONLINE       0     0     0
// 	    nvme-eui.00000000000000000000000000002092  ONLINE       0     0     0

// errors: No known data errors

// zpool status
//   pool: messier
//  state: ONLINE
//   scan: scrub repaired 0B in 00:09:15 with 0 errors on Sat Feb 15 18:14:23 2025
// config:

// 	NAME                                           STATE     READ WRITE CKSUM
// 	messier                                        ONLINE       0     0     0
// 	  mirror-0                                     ONLINE       0     0     0
// 	    nvme-eui.000000000000000000000000020929ae  ONLINE       0     0     0
// 	    nvme-eui.00000000000000000000000000002092  ONLINE       0     0     0

// errors: No known data errors
