const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const si = require('systeminformation');
const { zfs } = require('zfs');
const { I2C } = require('raspi-i2c');

let host = {
	system: () => {
		return si.system();
	},
	cpu: () => {
		return Promise.all([
			si.currentLoad(),
			si.cpuTemperature(),
			exec('cat /sys/devices/platform/cooling_fan/hwmon/hwmon*/fan1_input || true')
		])
			.then(([currentLoad, cpuTemperature, fan]) => {
				return { ...currentLoad, temperature: cpuTemperature, fan: (fan.stdout ? fan.stdout.trim() : '') };
			});
	},
	mem: () => {
		return si.mem()
			.then((memory) => {
				return memory;
			});
	},
	fs: () => {
		return Promise.all([
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
			.then(([filesystems, datasets]) => {
				return filesystems.map((fs) => {
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
			});
	},
	network: () => {
		return si.networkStats()
			.then((interfaces) => {
				return interfaces[0];
			});
	},
	ups: () => {
		return new Promise((resolve, reject) => {
			let batteryCharge = -1;
			let powerSource = '';
			try {
				const i2c = new I2C();
				batteryCharge = i2c.readByteSync(0x36, 4);
			} catch (error) {
				reject(error);
			}

			try {
				powerSource = fs.readFileSync('/tmp/ups_power_source', 'utf8');
			} catch (error) {
				reject(error);
			}

			resolve({
				batteryCharge: batteryCharge,
				powerSource: powerSource
			});
		});
	},
	time: () => {
		return si.time();
	}
};

module.exports = host;
