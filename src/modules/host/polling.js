const { execa } = require('execa');
const si = require('systeminformation');
const camelcaseKeys = require('camelcase-keys').default;
const Poller = require('../../utils/poller');

const polls = [];

const getNetworkStats = async (module) => {
	try {
		const networkStats = await si.networkStats();
		let networkInterfaceStats = networkStats[0];
		if (networkInterfaceStats.rx_sec === null) {
			networkInterfaceStats.rx_sec = 0;
		}
		if (networkInterfaceStats.tx_sec === null) {
			networkInterfaceStats.tx_sec = 0;
		}
		module.setState('networkStats', networkInterfaceStats);
	} catch (error) {
		module.setState('networkStats', false);
	}

	module.nsp.emit('host:network:stats', module.getState('networkStats'));
};

const getCpuStats = async (module) => {
	try {
		const currentLoad = await si.currentLoad();
		const cpuTemperature = await si.cpuTemperature();
		const fan = await execa('cat /sys/devices/platform/cooling_fan/hwmon/hwmon*/fan1_input || true', { shell: true, reject: false });
		module.setState('cpuStats', { ...currentLoad, temperature: cpuTemperature, fan: (fan.stdout ? fan.stdout.trim() : '') });
	} catch (error) {
		module.setState('cpuStats', false);
	}

	module.nsp.emit('host:cpu:stats', module.getState('cpuStats'));
};

const getMemory = async (module) => {
	try {
		const memory = await si.mem();
		module.setState('memory', memory);
	} catch (error) {
		module.setState('memory', false);
	}

	module.nsp.emit('host:memory', module.getState('memory'));
};

const getStorage = async (module) => {
	try {
		const { stdout: zpoolList } = await execa('zpool', ['list', '-jp', '--json-int'], { reject: false });
		const { stdout: zpoolStatus } = await execa('zpool', ['status', '-jp', '--json-int'], { reject: false });
		const pools = JSON.parse(zpoolList)?.pools || {};
		const statuses = JSON.parse(zpoolStatus)?.pools || {};
		let storage = Object.values(pools).map((pool) => {
			return { ...pool, ...statuses[pool.name] };
		});
		const filesystems = await si.fsSize();
		let filesystem = filesystems.find((filesystem) => { return filesystem.mount === '/'; });
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
		module.setState('storage', storage);
	} catch (error) {
		module.setState('storage', false);
	}

	module.nsp.emit('host:storage', module.getState('storage'));
};

const getDrives = async (module) => {
	try {
		const responseSmartctl = await execa(`smartctl --scan | awk '{print $1}' | xargs -I {} smartctl -a -j {} | jq -s .`, { shell: true, reject: false });
		const responseNvme = await execa(`smartctl --scan | awk '{print $1}' | xargs -I {} nvme id-ctrl -o json {} | jq -s '[.[] | {wctemp: (.wctemp - 273), cctemp: (.cctemp - 273)}]'`, { shell: true, reject: false });
		let drives = JSON.parse(responseSmartctl.stdout);
		let nvme = JSON.parse(responseNvme.stdout);
		module.setState('drives', drives.map((drive, index) => {
			return {
				name: drive.device.name,
				model: drive.model_name,
				serialNumber: drive.serial_number,
				capacity: drive.user_capacity,
				temperature: drive.temperature.current,
				temperatureWarningThreshold: (nvme.length > 0 ? nvme[index]?.wctemp : 99),
				temperatureCriticalThreshold: (nvme.length > 0 ? nvme[index]?.cctemp : 99)
			};
		}));
	} catch (error) {
		module.setState('drives', false);
	}

	module.nsp.emit('host:drives', module.getState('drives'));
};

const getTime = async (module) => {
	module.setState('time', si.time());
	module.nsp.emit('host:time', module.getState('time'));
};

module.exports = {
	name: 'polling',
	register: (module) => {
		polls.push(new Poller(module, getNetworkStats, 2000));
		polls.push(new Poller(module, getCpuStats, 5000));
		polls.push(new Poller(module, getMemory, 10000));
		polls.push(new Poller(module, getStorage, 60000));
		polls.push(new Poller(module, getDrives, 60000));
		polls.push(new Poller(module, getTime, 60000));
	},
	startPolling: () => {
		polls.forEach((poll) => {
			poll.start();
		});
	}
};
