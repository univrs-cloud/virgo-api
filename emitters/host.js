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
let state = {};
let timeouts = {};
let upgradePid = null;
let upgradePidFile = '/var/www/virgo-api/upgrade.pid';
let upgradeLogsWatcher = null;

si.system((data) => {
	state.system = data;
});

const reboot = (socket) => {
	if (!socket.isAuthenticated) {
		nsp.to(`user:${socket.user}`).emit('reboot', false);
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
			nsp.to(`user:${socket.user}`).emit('reboot', state.reboot);
		});
};

const shutdown = (socket) => {
	if (!socket.isAuthenticated) {
		nsp.to(`user:${socket.user}`).emit('shutdown', false);
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
			nsp.to(`user:${socket.user}`).emit('shutdown', state.shutdown);
		});
};

const checkUpdates = (socket) => {
	if (!socket.isAuthenticated) {
		nsp.to(`user:${socket.user}`).emit('checkUpdates', false);
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

const watchUpgradeLog = (socket) => {
	touch.sync('./upgrade.log');
	if (state.upgrade === undefined) {
		state.upgrade = {
			state: 'running',
			steps: []
		};
		readUpgradeLog();
	}
	upgradeLogsWatcher = fs.watch('./upgrade.log', (eventType) => {
		if (eventType === 'change') {
			readUpgradeLog();
		}
	});

	function readUpgradeLog() {
		fs.readFile('./upgrade.log', 'utf8', (error, data) => {
			if (error) {
				return;
			}
			
			data = data.toString().trim();
			if (data !== '') {
				state.upgrade.steps = data.split('\n');
				nsp.to(`user:${socket.user}`).emit('upgrade', state.upgrade);
			}
		});
	}
}

const checkUpgrade = (socket) => {
	if (!socket.isAuthenticated) {
		nsp.to(`user:${socket.user}`).emit('upgrade', false);
		return;
	}

	touch.sync(upgradePidFile);
	fs.readFile(upgradePidFile, 'utf8', (error, data) => {
		if (error || data.trim() === '') {
			upgradePid = null;
			console.log('upgrade null', error, data);
			nsp.to(`user:${socket.user}`).emit('upgrade', null);
			return;
		}

		upgradePid = parseInt(data.trim(), 10);
		
		if (upgradeLogsWatcher === null) {
			watchUpgradeLog(socket);
		}

		let intervalId = setInterval(() => {
			if (isUpgradeInProgress()) {
				return;
			}

			clearInterval(intervalId);
			state.upgrade.state = 'succeeded';
			nsp.to(`user:${socket.user}`).emit('upgrade', state.upgrade);
			delete state.upgrade;
			upgradeLogsWatcher.close();
			upgradeLogsWatcher = null;
			fs.closeSync(fs.openSync('./upgrade.log', 'w'));
			fs.closeSync(fs.openSync(upgradePidFile, 'w'));
			updates(socket);
		  }, 1000);
	});
};

const upgrade = (socket) => {
	if (!socket.isAuthenticated) {
		nsp.to(`user:${socket.user}`).emit('upgrade', false);
		return;
	}
	
	if (upgradePid !== null) {
		return;
	}
	
	state.upgrade = {
		state: 'running',
		steps: []
	};

	watchUpgradeLog(socket);
	
	exec(`systemd-run --unit=upgrade-system --description="System upgrade" --wait --collect --setenv=DEBIAN_FRONTEND=noninteractive bash -c "echo $$ > ${upgradePidFile}; apt-get upgrade -y > /var/www/virgo-api/upgrade.log 2>&1"`)
		.then(() => {
			checkUpgrade(socket);
		})
		.catch(() => {
			state.upgrade.state = 'failed';
			nsp.to(`user:${socket.user}`).emit('upgrade', state.upgrade);
			delete state.upgrade;
			upgradePid = null;
			fs.closeSync(fs.openSync(upgradePidFile, 'w'));
			updates(socket);
		});
};

const updates = (socket) => {
	if (!socket.isAuthenticated) {
		nsp.to(`user:${socket.user}`).emit('updates', false);
		return;
	}
	
	if (upgradePid === null) {
		console.log('upgradePid null', upgradePid);
		nsp.to(`user:${socket.user}`).emit('upgrade', null);
	}
	clearTimeout(timeouts.updates);
	delete timeouts.updates;
	pollUpdates(socket);
};

const pollUpdates = (socket) => {
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

	 ProxyHost.findAll()
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

const pollCpu = (socket) => {
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
			setTimeout(pollCpu.bind(null, socket), 5000);
		});
};

const pollMemory = (socket) => {
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
			setTimeout(pollMemory.bind(null, socket), 10000);
		});
};

const pollStorage = (socket) => {
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
			setTimeout(pollStorage.bind(null, socket), 60000);
		});
};

const pollDrives = (socket) => {
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
			setTimeout(pollDrives.bind(null, socket), 60000);
		});
};

const pollNetwork = (socket) => {
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
			setTimeout(pollNetwork.bind(null, socket), 2000);
		});
};

const pollUps = (socket) => {
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
		setTimeout(pollUps.bind(null, socket), 5000);
		return;
	}

	state.ups = {
		batteryCharge: batteryCharge,
		powerSource: powerSource
	};
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
		socket.state = {};
		socket.join(`user:${socket.user}`);

		checkUpgrade(socket);
		nsp.emit('system', state.system);
		if (state.reboot === undefined) {
			nsp.to(`user:${socket.user}`).emit('reboot', false);
		}
		if (state.shutdown === undefined) {
			nsp.to(`user:${socket.user}`).emit('shutdown', false);
		}
		if (state.checkUpdates) {
			nsp.to(`user:${socket.user}`).emit('checkUpdates', state.checkUpdates);
		}
		if (state.updates) {
			nsp.to(`user:${socket.user}`).emit('updates', state.updates);
		} else {
			pollUpdates(socket);
		}
		if (state.proxies) {
			nsp.emit('proxies', state.proxies);
		} else {
			pollProxies(socket);
		}
		if (state.cpu) {
			nsp.emit('cpu', state.cpu);
		} else {
			pollCpu(socket);
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
		if (state.network) {
			nsp.emit('network', state.network);
		} else {
			pollNetwork(socket);
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
		socket.on('reboot', () => { reboot(socket); });
		socket.on('shutdown', () => { shutdown(socket); });

		socket.on('disconnect', () => {
			//
		});
	});
};
