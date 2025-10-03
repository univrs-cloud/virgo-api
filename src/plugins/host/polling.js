const { execa } = require('execa');
const si = require('systeminformation');
const camelcaseKeys = require('camelcase-keys').default;

const pollCpuStats = async (socket, plugin) => {
	if (plugin.getNsp().server.engine.clientsCount === 0) {
		plugin.setState('cpuStats', undefined);
		return;
	}

	try {
		const currentLoad = await si.currentLoad();
		const cpuTemperature = await si.cpuTemperature();
		const fan = await execa('cat /sys/devices/platform/cooling_fan/hwmon/hwmon*/fan1_input || true', { shell: true, reject: false });
		plugin.setState('cpuStats', { ...currentLoad, temperature: cpuTemperature, fan: (fan.stdout ? fan.stdout.trim() : '') });
	} catch (error) {
		plugin.setState('cpuStats', false);
	}

	plugin.getNsp().emit('host:cpu:stats', plugin.getState('cpuStats'));
	setTimeout(() => { pollCpuStats(socket, plugin); }, 5000);
};

const pollMemory = async (socket, plugin) => {
	if (plugin.getNsp().server.engine.clientsCount === 0) {
		plugin.setState('memory', undefined);
		return;
	}

	try {
		const memory = await si.mem();
		plugin.setState('memory', memory);
	} catch (error) {
		plugin.setState('memory', false);
	}

	plugin.getNsp().emit('host:memory', plugin.getState('memory'));
	setTimeout(() => { pollMemory(socket, plugin); }, 10000);
};

const pollStorage = async (socket, plugin) => {
	if (plugin.getNsp().server.engine.clientsCount === 0) {
		plugin.setState('storage', undefined);
		return;
	}

	try {
		const poolsList = await execa('zpool', ['list', '-jp', '--json-int'], { reject: false }).pipe('jq');
		const poolsStatus = await execa('zpool', ['status', '-jp', '--json-int'], { reject: false }).pipe('jq');
		const filesystems = await si.fsSize();
		const pools = JSON.parse(poolsStatus.stdout).pools;
		let storage = Object.values(JSON.parse(poolsList.stdout).pools).map((pool) => {
			return { ...pool, ...pools[pool.name] };
		});
		let filesystem = filesystems.find((filesystem) => {
			return filesystem.mount === '/';
		});
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
		plugin.setState('storage', storage);
	} catch (error) {
		plugin.setState('storage', false);
	}

	plugin.getNsp().emit('host:storage', plugin.getState('storage'));
	setTimeout(() => { pollStorage(socket, plugin); }, 60000);
};

const pollDrives = async (socket, plugin) => {
	if (plugin.getNsp().server.engine.clientsCount === 0) {
		plugin.setState('drives', undefined);
		return;
	}

	try {
		const responseSmartctl = await execa(`smartctl --scan | awk '{print $1}' | xargs -I {} smartctl -a -j {} | jq -s .`, { shell: true, reject: false });
		const responseNvme = await execa(`smartctl --scan | awk '{print $1}' | xargs -I {} nvme id-ctrl -o json {} | jq -s '[.[] | {wctemp: (.wctemp - 273), cctemp: (.cctemp - 273)}]'`, { shell: true, reject: false });
		let drives = JSON.parse(responseSmartctl.stdout);
		let nvme = JSON.parse(responseNvme.stdout);
		plugin.setState('drives', drives.map((drive, index) => {
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
		plugin.setState('drives', false);
	}

	plugin.getNsp().emit('host:drives', plugin.getState('drives'));
	setTimeout(() => { pollDrives(socket, plugin); }, 60000);
};

const pollNetworkStats = async (socket, plugin) => {
	if (plugin.getNsp().server.engine.clientsCount === 0) {
		plugin.setState('networkStats', undefined);
		return;
	}

	try {
		const networkStats = await si.networkStats();
		let networkInterfaceStats = networkStats[0];
		if (networkInterfaceStats.rx_sec === null) {
			networkInterfaceStats.rx_sec = 0;
		}
		if (networkInterfaceStats.tx_sec === null) {
			networkInterfaceStats.tx_sec = 0;
		}
		plugin.setState('networkStats', networkInterfaceStats);
	} catch (error) {
		plugin.setState('networkStats', false);
	}

	plugin.getNsp().emit('host:network:stats', plugin.getState('networkStats'));
	setTimeout(() => { pollNetworkStats(socket, plugin); }, 2000);
};

const pollTime = (socket, plugin) => {
	if (plugin.getNsp().server.engine.clientsCount === 0) {
		plugin.setState('time', undefined);
		return;
	}

	plugin.setState('time', si.time());
	plugin.getNsp().emit('host:time', plugin.getState('time'));
	setTimeout(() => { pollTime(socket, plugin); }, 60000);
};

module.exports = {
	name: 'polling',
	pollCpuStats,
	pollMemory,
	pollStorage,
	pollDrives,
	pollNetworkStats,
	pollTime
};
