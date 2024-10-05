const fs = require('fs');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const spawn = childProcess.spawn;
const touch = require('touch');
const { Sequelize, DataTypes } = require('sequelize');
const si = require('systeminformation');
const { zpool } = require('@univrs/zfs');
const { I2C } = require('raspi-i2c');

let isAuthenticated = false;
let i2c;
try {
	i2c = new I2C();
} catch (error) {
	i2c = false;
}

const sequelize = new Sequelize({
	dialect: 'sqlite',
	storage: '/portainer/Files/AppData/Config/nginx-proxy-manager/data/database.sqlite',
	define: {
		timestamps: false
	}
});
const ProxyHost = sequelize.define(
	'ProxyHost',
	{
		enabled: DataTypes.BOOLEAN,
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
let timeouts = {};
let state = {};
let upgradePid = null;
let upgradePidFile = '/var/www/virgo-api/upgrade.pid';
let upgradeLogsWatcher = null;

const reboot = () => {
	if (!isAuthenticated) {
		nsp.emit('reboot', false);
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

const shutdown = () => {
	if (!isAuthenticated) {
		nsp.emit('shutdown', false);
		return;
	}

	if (state.shutdown !== undefined) {
		return;
	}

	exec('sleep 5 && shutdown -h now')
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

const isUpgradeInProgress = () => {
	try {
		process.kill(upgradePid, 0);
		return true;
	} catch (error) {
		return false;
	}
};

const watchUpgradeLog = () => {
	touch.sync('./upgrade.log');
	upgradeLogsWatcher = fs.watch('./upgrade.log', (eventType) => {
		if (eventType === 'change') {
			fs.readFile('./upgrade.log', 'utf8', (error, data) => {
				if (error) {
					return;
				}
				
				data = data.toString().trim();
				if (data !== '') {
					state.upgrade.steps = data.split('\n');
					nsp.emit('upgrade', state.upgrade);
				}
			});
		}
	});
}

const checkUpgrade = () => {
	touch.sync(upgradePidFile);
	fs.readFile(upgradePidFile, 'utf8', (error, data) => {
		if (error || data === '') {
			upgradePid = null;
		  	return;
		}

		upgradePid = parseInt(data.trim(), 10);
		
		let intervalId = setInterval(() => {
			if (isUpgradeInProgress()) {
				if (upgradeLogsWatcher === null) {
					watchUpgradeLog();
				}
				return;
			}

			clearInterval(intervalId);
			state.upgrade.state = 'succeeded';
			nsp.emit('upgrade', state.upgrade);
			delete state.upgrade;
			checkUpdates();
			upgradeLogsWatcher.close();
			upgradeLogsWatcher = null;
			fs.closeSync(fs.openSync('./upgrade.log', 'w'));
			fs.closeSync(fs.openSync(upgradePidFile, 'w'));
		  }, 1000);
	});
};

const upgrade = () => {
	if (!isAuthenticated) {
		nsp.emit('upgrade', false);
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

	exec(`systemd-run --unit=upgrade-system --description="System upgrade" --wait --collect --property=PIDFile=${upgradePidFile} --setenv=DEBIAN_FRONTEND=noninteractive bash -c "echo $$ > ${upgradePidFile}; apt-get upgrade -y > /var/www/virgo-api/upgrade.log 2>&1"`)
		.then(() => {
			checkUpgrade();
		})
		.catch(() => {
			state.upgrade.state = 'failed';
			nsp.emit('upgrade', state.upgrade);
			delete state.upgrade;
			checkUpdates();
			fs.closeSync(fs.openSync(upgradePidFile, 'w'));
		});
};

const checkUpdates = () => {
	if (!isAuthenticated) {
		nsp.emit('updates', false);
		return;
	}
	
	if (upgradePid === null) {
		nsp.emit('upgrade', null);
	}
	clearTimeout(timeouts.updates);
	delete timeouts.updates;
	pollUpdates();
};

const pollUpdates = () => {
	exec('apt-show-versions -u')
		.then((response) => {
			let stdout = response.stdout.trim();
			if (stdout === '') {
				state.updates = [];
				return;
			}
			state.updates = stdout.split('\n').map((line) => {
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
			nsp.emit('updates', state.updates);
			timeouts.updates = setTimeout(pollUpdates, 3600000);
		});
};

const pollProxies = () => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.proxies;
		return;
	}

	 ProxyHost.findAll()
	 	.then((proxies) => {
			state.proxies = proxies;
		})
		.catch((error) => {
			state.proxies = false;
		})
		.then(() => {
			nsp.emit('proxies', state.proxies);
			setTimeout(pollProxies, 3600000);
		});
};

const pollCpu = () => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.cpu;
		return;
	}

	Promise.all([
		si.currentLoad(),
		si.cpuTemperature(),
		exec('cat /sys/devices/platform/cooling_fan/hwmon/hwmon*/fan1_input || true')
	])
		.then(([currentLoad, cpuTemperature, fan]) => {
			state.cpu = { ...currentLoad, temperature: cpuTemperature, fan: (fan.stdout ? fan.stdout.trim() : '') };

		})
		.catch((error) => {
			state.cpu = false;
		})
		.then(() => {
			nsp.emit('cpu', state.cpu);
			setTimeout(pollCpu, 5000);
		});
};

const pollMemory = () => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.memory;
		return;
	}

	si.mem()
		.then((memory) => {
			state.memory = memory;
		})
		.catch((error) => {
			state.memory = false;
		})
		.then(() => {
			nsp.emit('memory', state.memory);
			setTimeout(pollMemory, 10000);
		});
};

const pollStorage = () => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.storage;
		return;
	}

	Promise.all([
		new Promise((resolve, reject) => {
			zpool.list((error, pools) => {
				if (error) {
					return reject(error);
				}

				resolve(pools);
			});
		}),
		si.fsSize()
	])
		.then(([pools, filesystem]) => {
			let fs = filesystem.find((fs) => {
				return fs.mount === '/';
			});
			if (fs) {
				let pool = {
					name: 'system',
					size: fs.size,
					alloc: fs.used,
					free: fs.available,
					cap: fs.use,
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
			setTimeout(pollStorage, 60000);
		});
};

const pollDrives = () => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.drives;
		return;
	}

	exec("smartctl --scan | awk '{print $1}' | xargs -I {} smartctl -a -j {} | jq -s .")
		.then((response) => {
			let stdout = JSON.parse(response.stdout);
			state.drives = stdout.map((drive) => {
				return {
					name: drive.device.name,
					temperature: drive.temperature.current
				};
			});
		})
		.catch((error) => {
			state.drives = false;
		})
		.then(() => {
			nsp.emit('drives', state.drives);
			setTimeout(pollDrives, 60000);
		});
};

const pollNetwork = () => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.network;
		return;
	}

	si.networkStats()
		.then((interfaces) => {
			let iface = interfaces[0];
			if (iface.rx_sec === null) {
				iface.rx_sec = 0;
			}
			if (iface.tx_sec === null) {
				iface.tx_sec = 0;
			}
			state.network = iface;
		})
		.catch((error) => {
			state.network = false;
		})
		.then(() => {
			nsp.emit('network', state.network);
			setTimeout(pollNetwork, 2000);
		});
};

const pollUps = () => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.ups;
		return;
	}

	if (!i2c) {
		state.ups = 'remote i/o error';
		nsp.emit('ups', state.ups);
		return;
	}

	let batteryCharge;
	try {
		batteryCharge = i2c.readByteSync(0x36, 4);
	} catch (error) {
		state.ups = [];
		nsp.emit('ups', state.ups);
		return;
	}

	let powerSource = '';
	try {
		powerSource = fs.readFileSync('/tmp/ups_power_source', 'utf8');
	} catch (error) {
		state.ups = error.message;
		nsp.emit('ups', state.ups);
		setTimeout(pollUps, 5000);
		return;
	}

	state.ups = {
		batteryCharge: batteryCharge,
		powerSource: powerSource
	};
	nsp.emit('ups', state.ups);
	setTimeout(pollUps, 60000);
};

const pollTime = () => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.time;
		return;
	}

	state.time = si.time();
	nsp.emit('time', state.time);
	setTimeout(pollTime, 60000);
};

module.exports = (io) => {
	si.system()
		.then((system) => {
			state.system = system;
		});

	nsp = io.of('/host').on('connection', (socket) => {
		isAuthenticated = socket.handshake.headers['remote-user'] !== undefined;
		checkUpgrade();
		if (state.system) {
			nsp.emit('system', state.system);
		}
		if (state.reboot === undefined) {
			nsp.emit('reboot', false);
		}
		if (state.shutdown === undefined) {
			nsp.emit('shutdown', false);
		}
		if (state.updates) {
			nsp.emit('updates', state.updates);
		} else {
			pollUpdates();
		}
		if (state.proxies) {
			nsp.emit('proxies', state.proxies);
		} else {
			pollProxies();
		}
		if (state.cpu) {
			nsp.emit('cpu', state.cpu);
		} else {
			pollCpu();
		}
		if (state.memory) {
			nsp.emit('memory', state.memory);
		} else {
			pollMemory();
		}
		if (state.storage) {
			nsp.emit('storage', state.storage);
		} else {
			pollStorage();
		}
		if (state.drives) {
			nsp.emit('drives', state.drives);
		} else {
			pollDrives();
		}
		if (state.network) {
			nsp.emit('network', state.network);
		} else {
			pollNetwork();
		}
		if (state.ups) {
			nsp.emit('ups', state.ups);
		} else {
			pollUps();
		}
		if (state.time) {
			nsp.emit('time', state.time);
		} else {
			pollTime();
		}

		socket.on('updates', checkUpdates);
		socket.on('upgrade', upgrade);
		socket.on('reboot', reboot);
		socket.on('shutdown', shutdown);

		socket.on('disconnect', () => {
			//
		});
	});
};
