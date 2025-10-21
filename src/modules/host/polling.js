const { execa } = require('execa');
const si = require('systeminformation');
const camelcaseKeys = require('camelcase-keys').default;

const CACHE_TTL = 1 * 60 * 1000; // 1 minute in ms

const pollNetworkStatsOnce = async (socket, plugin) => {
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
};

const pollCpuStatsOnce = async (socket, plugin) => {
	try {
		const currentLoad = await si.currentLoad();
		const cpuTemperature = await si.cpuTemperature();
		const fan = await execa('cat /sys/devices/platform/cooling_fan/hwmon/hwmon*/fan1_input || true', { shell: true, reject: false });
		plugin.setState('cpuStats', { ...currentLoad, temperature: cpuTemperature, fan: (fan.stdout ? fan.stdout.trim() : '') });
	} catch (error) {
		plugin.setState('cpuStats', false);
	}

	plugin.getNsp().emit('host:cpu:stats', plugin.getState('cpuStats'));
};

const pollMemoryOnce = async (socket, plugin) => {
	try {
		const memory = await si.mem();
		plugin.setState('memory', memory);
	} catch (error) {
		plugin.setState('memory', false);
	}

	plugin.getNsp().emit('host:memory', plugin.getState('memory'));
};

const pollStorageOnce = async (socket, plugin) => {
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
};

const pollDrivesOnce = async (socket, plugin) => {
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
};

const pollTimeOnce = async (socket, plugin) => {
	plugin.setState('time', si.time());
	plugin.getNsp().emit('host:time', plugin.getState('time'));
};

const poll = (socket, plugin, entity, interval) => {
	if (polls[entity].polling) {
		return;
	}

	const loop = async () => {
		if (plugin.getNsp().server.engine.clientsCount === 0) {
			if (!polls[entity].timeouts) {
				polls[entity].timeouts = setTimeout(() => {
					clearTimeout(polls[entity].polling);
					polls[entity].polling = null;
					polls[entity].timeouts = null;
					plugin.setState(entity, undefined);
				}, CACHE_TTL);
			}
		} else {
			if (polls[entity].timeouts) {
				clearTimeout(polls[entity].timeouts);
				polls[entity].timeouts = null;
			}
		}
		
		await polls[entity].callbacks(socket, plugin);
		if (polls[entity].polling !== null) {
			polls[entity].polling = setTimeout(loop, interval);
		}
	};

	loop();
};

const polls = {
	networkStats: {
		callbacks: pollNetworkStatsOnce,
		polling: false,
		timeouts: null
	},
	cpuStats: {
		callbacks: pollCpuStatsOnce,
		polling: false,
		timeouts: null
	},
	memory: {
		callbacks: pollMemoryOnce,
		polling: false,
		timeouts: null
	},
	storage: {
		callbacks: pollStorageOnce,
		polling: false,
		timeouts: null
	},
	drives: {
		callbacks: pollDrivesOnce,
		polling: false,
		timeouts: null
	},
	time: {
		callbacks: pollTimeOnce,
		polling: false,
		timeouts: null
	}
};

const startPolling = (socket, plugin) => {
	poll(socket, plugin, 'networkStats', 2000);
	poll(socket, plugin, 'cpuStats', 5000);
	poll(socket, plugin, 'memory', 10000);
	poll(socket, plugin, 'storage', 60000);
	poll(socket, plugin, 'drives', 60000);
	poll(socket, plugin, 'time', 60000);
};

module.exports = {
	name: 'polling',
	startPolling
};
