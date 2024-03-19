const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const si = require('systeminformation');
const { zfs } = require('zfs');
const { I2C } = require('raspi-i2c');

let i2c;
try {
	i2c = new I2C();
} catch (error) {
	i2c = false;
}

let io;
let state = {};

const setIo = (value) => {
	io = value;
};

const pollCpu = () => {
	if (io.engine.clientsCount === 0) {
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

const pollFilesystem = () => {
	if (io.engine.clientsCount === 0) {
		return;
	}

	Promise.all([
		si.fsSize(),
		new Promise((resolve, reject) => {
			zfs.list((error, datasets) => {
				if (error) {
					return reject(error);
				}

				resolve(datasets);
			});
		})
	])
		.then(([filesystem, datasets]) => {
			filesystem.map((fs) => {
				if (fs.type === 'zfs') {
					let dataset = datasets.find((dataset) => {
						return dataset.name === fs.fs;
					});
					fs.used = dataset.used;
					fs.available = dataset.avail;
					fs.size = dataset.used + dataset.avail;
					fs.use = dataset.used * 100 / (dataset.used + dataset.avail);
				}
				return fs;
			});
			state.filesystem = filesystem;
		})
		.catch((error) => {
			state.filesystem = false;
		})
		.then(() => {
			io.emit('filesystem', state.filesystem);
			setTimeout(pollFilesystem, 60000);
		});
};

const pollNetwork = () => {
	if (io.engine.clientsCount === 0) {
		return;
	}

	si.networkStats()
		.then((interfaces) => {
			state.network = interfaces[0];
			
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
		return;
	}

	if (!i2c) {
		state.ups = 'remote i/o error';
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
		batteryCharge: i2c.readByteSync(0x36, 4),
		powerSource: powerSource
	};
	io.emit('ups', state.ups);
	setTimeout(pollUps, 60000);
};

const pollTime = () => {
	if (io.engine.clientsCount === 0) {
		return;
	}

	state.time = si.time();
	io.emit('time', state.time);
	setTimeout(pollTime, 60000);
};

module.exports = (io) => {	
	setIo(io);
	
	io.on('connection', (socket) => {
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
		if (state.filesystem) {
			io.emit('filesystem', state.filesystem);
		} else {
			pollFilesystem();
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
		
		socket.on('disconnect', () => {
			//
		});
	});
};
