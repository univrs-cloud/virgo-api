const util = require('util');
const exec = util.promisify(require('child_process').exec);
const si = require('systeminformation');
const { zfs } = require('zfs');
const { I2C } = require('raspi-i2c');

const i2c = new I2C();

let stats = {
	system: () => {
		return Promise.all([
			si.osInfo(),
			si.cpuTemperature(),
			exec('cat /sys/devices/platform/cooling_fan/hwmon/hwmon*/fan1_input || true')
		])
			.then(([os, cpuTemperature, fan]) => {
				os.os_version = `${cpuTemperature.main.toFixed()}° C`;
				os.hostname = (fan.stdout ? `${fan.stdout.trim()} rpm` : '');
				return os;
			});
	},
	cpu: () => {
		return Promise.all([
			si.currentLoad()
		])
			.then(([currentLoad]) => {
				return currentLoad;
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
		return si.networkStats('*')
			.then((interfaces) => {
				return interfaces;
			});
	},
	ups: () => {
		return new Promise((resolve, reject) => {
			try {
				let stats = {
					battery_charge: i2c.readByteSync(0x36, 4),
					ups_status: "OL" // OL(online) OB(onbatery)
				};
				resolve(stats);
			} catch (error) {
				reject(error);
			}
		});
	}
};

module.exports = stats;
