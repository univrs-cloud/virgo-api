const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
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

let io;
let state = {};

const setIo = (value) => {
	io = value;
};

const pollUpdates = () => {
	if (io.engine.clientsCount === 0) {
		delete state.updates;
		return;
	}

	exec('apt-show-versions -u')
		.then((response) => {
			state.updates = response.stdout.trim().split('\n').map((line) => {
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
			io.emit('updates', state.updates);
			setTimeout(pollUpdates, 3600000);
		});
};

const pollProxies = () => {
	if (io.engine.clientsCount === 0) {
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
			io.emit('proxies', state.proxies);
			setTimeout(pollProxies, 3600000);
		});
};

const pollCpu = () => {
	if (io.engine.clientsCount === 0) {
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
			io.emit('cpu', state.cpu);
			setTimeout(pollCpu, 5000);
		});
};

const pollMemory = () => {
	if (io.engine.clientsCount === 0) {
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
			io.emit('memory', state.memory);
			setTimeout(pollMemory, 10000);
		});
};

const pollStorage = () => {
	if (io.engine.clientsCount === 0) {
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
			io.emit('storage', state.storage);
			setTimeout(pollStorage, 60000);
		});
};

const pollNetwork = () => {
	if (io.engine.clientsCount === 0) {
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
			io.emit('network', state.network);
			setTimeout(pollNetwork, 2000);
		});
};

const pollUps = () => {
	if (io.engine.clientsCount === 0) {
		delete state.ups;
		return;
	}

	if (!i2c) {
		state.ups = 'remote i/o error';
		io.emit('ups', state.ups);
		return;
	}

	let batteryCharge;
	try {
		batteryCharge = i2c.readByteSync(0x36, 4);
	} catch (error) {
		state.ups = [];
		io.emit('ups', state.ups);
		return;
	}

	let powerSource = '';
	try {
		powerSource = fs.readFileSync('/tmp/ups_power_source', 'utf8');
	} catch (error) {
		state.ups = error.message;
		io.emit('ups', state.ups);
		setTimeout(pollUps, 5000);
		return;
	}

	state.ups = {
		batteryCharge: batteryCharge,
		powerSource: powerSource
	};
	io.emit('ups', state.ups);
	setTimeout(pollUps, 60000);
};

const pollTime = () => {
	if (io.engine.clientsCount === 0) {
		delete state.time;
		return;
	}

	state.time = si.time();
	io.emit('time', state.time);
	setTimeout(pollTime, 60000);
};

const upgrade = () => {
	// TODO: run upgrade command
};

module.exports = (io) => {
	setIo(io);
	
	si.system()
		.then((system) => {
			state.system = system;
		});
	
	io.on('connection', (socket) => {
		if (state.system) {
			io.emit('system', state.system);
		}
		if (state.updates) {
			io.emit('updates', state.updates);
		} else {
			pollUpdates();
		}
		if (state.proxies) {
			io.emit('proxies', state.proxies);
		} else {
			pollProxies();
		}
		if (state.cpu) {
			io.emit('cpu', state.cpu);
		} else {
			pollCpu();
		}
		if (state.memory) {
			io.emit('memory', state.memory);
		} else {
			pollMemory();
		}
		if (state.storage) {
			io.emit('storage', state.storage);
		} else {
			pollStorage();
		}
		if (state.network) {
			io.emit('network', state.network);
		} else {
			pollNetwork();
		}
		if (state.ups) {
			io.emit('ups', state.ups);
		} else {
			pollUps();
		}
		if (state.time) {
			io.emit('time', state.time);
		} else {
			pollTime();
		}

		socket.on('upgrade', upgrade);
		
		socket.on('disconnect', () => {
			//
		});
	});
};
