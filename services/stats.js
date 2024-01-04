const si = require('systeminformation');
const { zfs } = require('zfs');
const { I2C } = require('raspi-i2c');

const i2c = new I2C();

let stats = {
	system: () => {
		return Promise.all([
			si.osInfo(),
			si.cpuTemperature()
		])
			.then(([os, cpuTemperature]) => {
				os.os_version = `${cpuTemperature.main.toFixed()}°C`;
				return os;
			});
	},
	cpu: () => {
		return Promise.all([
			si.currentLoad()
		])
			.then(([currentLoad]) => {
				return {
					'total': currentLoad.currentLoad
				};
			});
	},
	mem: () => {
		return si.mem()
			.then((memory) => {
				memory.percent = memory.used * 100 / memory.total;
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
					let filesystem = {
						'device_name': fs.fs,
						'fs_type': fs.type,
						'mnt_point': fs.mount,
						'size': fs.size,
						'used': fs.used,
						'free': fs.available,
						'percent': fs.use,
						'key': 'mnt_point'
					};
					if (fs.type === 'zfs') {
						let dataset = datasets.find((dataset) => {
							return dataset.name === fs.fs;
						});
						filesystem.used = dataset.used;
						filesystem.free = dataset.avail;
						filesystem.percent = dataset.used * 100 / (dataset.used + dataset.avail);
					}
					
					return filesystem;
				});
			});
	},
	network: () => {
		return si.networkStats('*')
			.then((interfaces) => {
				return interfaces.map((nif) => {
					let interface = {
						'interface_name': nif.iface,
						'rx': nif.rx_sec * (nif.ms / 1000),
						'tx': nif.tx_sec * (nif.ms / 1000),
						'cx': nif.rx_sec * (nif.ms / 1000) + nif.tx_sec * (nif.ms / 1000),
						'time_since_update': nif.ms / 1000,
						'key': 'interface_name'
					}
					return interface;
				});
			});
	},
	ups: () => {
		return new Promise((resolve, reject) => {
			let stats = {
				battery_charge: i2c.readByteSync(0x36, 4),
				ups_status: "OL" // OL(online) OB(onbatery)
			};
			resolve(stats);
		});
	}
};

module.exports = stats;
