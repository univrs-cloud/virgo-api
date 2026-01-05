const { execa } = require('execa');
const si = require('systeminformation');
const camelcaseKeys = require('camelcase-keys').default;
const Poller = require('../../utils/poller');

const polls = [];

const getNetworkStats = async (module) => {
	try {
		const system = module.getState('system');
		const defaultInterface = system?.networkInterfaces?.find((iface) => { return iface.default; });
		const ifaceName = defaultInterface?.ifname || null;
		const networkStats = await si.networkStats(ifaceName);
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
		const { stdout: fan } = await execa('cat /sys/devices/platform/cooling_fan/hwmon/hwmon*/fan1_input || true', { shell: true });
		module.setState('cpuStats', { ...currentLoad, temperature: cpuTemperature, fan: (fan ? fan.trim() : '') });
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
		const [{ stdout: zpoolList }, { stdout: zpoolStatus }] = await Promise.all([
			execa('zpool', ['list', '-j', '--json-int']),
			execa('zpool', ['status', '-j', '--json-int'])
		]);
		const pools = JSON.parse(zpoolList)?.pools || {};
		const statuses = JSON.parse(zpoolStatus)?.pools || {};
		let storage = [];
		for (const pool of Object.values(pools)) {
				const { stdout: zfsList } = await execa('zfs', ['list', '-o', 'usedbydataset,usedbysnapshots', '-r', pool.name, '-j', '--json-int']);
				const datasets = JSON.parse(zfsList)?.datasets || {};
				const datasetsSize = Object.values(datasets).reduce((sum, dataset) => {
					return sum + (dataset?.properties?.usedbydataset?.value || 0);
				}, 0);
				const snapshotsSize = Object.values(datasets).reduce((sum, dataset) => {
					return sum + (dataset?.properties?.usedbysnapshots?.value || 0);
				}, 0);
				pool.properties.usedbydatasets = { value: datasetsSize };
				pool.properties.usedbysnapshots = { value: snapshotsSize };
				storage.push({ ...pool, ...statuses[pool.name] });
		}
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
		const [{ stdout: smartctl }, { stdout: nvmeList }] = await Promise.all([
			execa(`smartctl --scan | awk '{print $1}' | xargs -I {} smartctl -a -j {} | jq -s .`, { shell: true }),
			execa(`smartctl --scan | awk '{print $1}' | xargs -I {} nvme id-ctrl -o json {} | jq -s '[.[] | {wctemp: (.wctemp - 273), cctemp: (.cctemp - 273)}]'`, { shell: true })
		])
		let drives = JSON.parse(smartctl);
		let nvme = JSON.parse(nvmeList);
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

const register = (module) => {
	polls.push(new Poller(module, getNetworkStats, 2000));
	polls.push(new Poller(module, getCpuStats, 5000));
	polls.push(new Poller(module, getMemory, 10000));
	polls.push(new Poller(module, getStorage, 60000));
	polls.push(new Poller(module, getDrives, 60000));
	polls.push(new Poller(module, getTime, 60000));
};

const startPolling = () => {
	polls.forEach((poll) => {
		poll.start();
	});
};

module.exports = {
	name: 'polling',
	register,
	startPolling
};
