import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import StatsService from '../../database/stats_service.js';

const SAMPLE_INTERVAL_MS = 1000;
const SAVE_INTERVAL_MS = 60 * 1000;
const HISTORY_MS = 60 * 60 * 1000;
const MEMINFO_FILE = '/proc/meminfo';
const ARCSTATS_FILE = '/proc/spl/kstat/zfs/arcstats';
const NETWORK_DIR = '/sys/class/net';
const THERMAL_DIR = '/sys/class/thermal';
const HWMON_DIR = '/sys/class/hwmon';
const FAN_DIR = '/sys/devices/platform/cooling_fan/hwmon';

let history = [];
let savedUntil = 0;
let defaultInterface = null;
let previousReading = null;
let saveQueue = Promise.resolve();

const saveSamples = async () => {
	try {
		const pending = history.filter((sample) => { return sample.time > savedUntil; });
		if (await StatsService.saveSamples(pending, Date.now() - HISTORY_MS)) {
			savedUntil = (pending.at(-1)?.time ?? savedUntil);
		}
	} catch (error) {
		console.error('saveSamples:', error);
	}
};

const queueSave = () => {
	saveQueue = saveQueue.then(saveSamples);
	return saveQueue;
};

const readCpuTimes = () => {
	return os.cpus().reduce((times, cpu) => {
		const { user, nice, sys, idle, irq } = cpu.times;
		return {
			busy: times.busy + user + nice + sys + irq,
			total: times.total + user + nice + sys + idle + irq
		};
	}, { busy: 0, total: 0 });
};

const readMemory = async () => {
	const meminfo = await fs.readFile(MEMINFO_FILE, 'utf8');
	const readKilobytes = (key) => {
		return Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(meminfo)?.[1] || 0);
	};
	const total = readKilobytes('MemTotal') * 1024;
	return { total, used: total - (readKilobytes('MemAvailable') * 1024) };
};

const readArcSize = async () => {
	try {
		const arcstats = await fs.readFile(ARCSTATS_FILE, 'utf8');
		return Number(/^size\s+\d+\s+(\d+)$/m.exec(arcstats)?.[1] || 0);
	} catch (error) {
		return 0;
	}
};

const findDefaultInterface = (module) => {
	const system = module.getState('system');
	return (system?.networkInterfaces?.find?.((networkInterface) => { return networkInterface.default; })?.ifname ?? null);
};

const readNetworkBytes = async (module) => {
	if (!defaultInterface) {
		defaultInterface = findDefaultInterface(module);
	}

	if (!defaultInterface) {
		return null;
	}

	try {
		const [rx, tx] = await Promise.all(['rx_bytes', 'tx_bytes'].map(async (counter) => {
			return Number(await fs.readFile(path.join(NETWORK_DIR, defaultInterface, 'statistics', counter), 'utf8'));
		}));
		return { interface: defaultInterface, rx, tx };
	} catch (error) {
		return null;
	}
};

const getNetworkRate = (network, previousNetwork, seconds) => {
	if (!network || !previousNetwork || network.interface !== previousNetwork.interface || seconds <= 0) {
		return { rx: 0, tx: 0 };
	}

	return {
		rx: Math.round(Math.max(network.rx - previousNetwork.rx, 0) / seconds),
		tx: Math.round(Math.max(network.tx - previousNetwork.tx, 0) / seconds)
	};
};

const recordSample = async (module) => {
	try {
		const time = Date.now();
		const [memory, arc, network] = await Promise.all([readMemory(), readArcSize(), readNetworkBytes(module)]);
		const reading = { time, cpu: readCpuTimes(), network };
		if (previousReading) {
			const cpuTotal = reading.cpu.total - previousReading.cpu.total;
			const cpuBusy = reading.cpu.busy - previousReading.cpu.busy;
			const { rx, tx } = getNetworkRate(reading.network, previousReading.network, (time - previousReading.time) / 1000);
			const sample = {
				time: Math.round(time / 1000) * 1000,
				cpu: (cpuTotal > 0 ? Math.round((cpuBusy / cpuTotal) * 1000) / 10 : 0),
				memory: memory.used,
				arc,
				rx,
				tx
			};
			history.push(sample);
			while (history.length > 0 && history[0].time <= time - HISTORY_MS) {
				history.shift();
			}
			module.setState('stats', history);
			module.nsp.emit('host:stats', sample);
		}
		previousReading = reading;
	} catch (error) {
		console.error('recordSample:', error);
	}
};

const readText = async (filePath) => {
	try {
		return (await fs.readFile(filePath, 'utf8')).trim();
	} catch (error) {
		return null;
	}
};

const readEntries = async (directory, prefix) => {
	try {
		return (await fs.readdir(directory)).filter((entry) => { return entry.startsWith(prefix); }).sort();
	} catch (error) {
		return [];
	}
};

const toCelsius = (millidegrees) => {
	return Math.round(parseInt(millidegrees, 10) / 100) / 10;
};

const readHwmonTemperature = async () => {
	const readings = [];
	for (const monitor of await readEntries(HWMON_DIR, 'hwmon')) {
		const labels = (await readEntries(path.join(HWMON_DIR, monitor), 'temp')).filter((entry) => { return entry.endsWith('_label'); });
		for (const label of labels) {
			readings.push({
				label: ((await readText(path.join(HWMON_DIR, monitor, label))) ?? '').toLowerCase(),
				value: await readText(path.join(HWMON_DIR, monitor, label.replace(/_label$/, '_input')))
			});
		}
	}

	const tdieIndex = readings.findIndex((reading) => { return reading.label.includes('tdie'); });
	let temperature = null;
	const cores = [];
	for (const { label, value } of (tdieIndex === -1 ? readings : readings.slice(tdieIndex))) {
		if (!value || !label) {
			continue;
		}

		if (label === 'tctl') {
			temperature = toCelsius(value);
		}
		if (label.startsWith('core')) {
			cores.push(toCelsius(value));
		} else if (temperature === null && (label.includes('package') || label.includes('physical') || label === 'tccd1')) {
			temperature = toCelsius(value);
		}
	}

	if (temperature === null && cores.length > 0) {
		temperature = Math.round(cores.reduce((sum, core) => { return sum + core; }, 0) / cores.length);
	}
	return temperature;
};

const readThermalTemperature = async () => {
	for (const zone of await readEntries(THERMAL_DIR, 'thermal_zone')) {
		const type = await readText(path.join(THERMAL_DIR, zone, 'type'));
		const temperature = await readText(path.join(THERMAL_DIR, zone, 'temp'));
		if (type?.toLowerCase().includes('cpu') && temperature) {
			return toCelsius(temperature);
		}
	}

	const fallback = await readText(path.join(THERMAL_DIR, 'thermal_zone0', 'temp'));
	return (fallback ? toCelsius(fallback) : null);
};

const readCpuTemperature = async () => {
	return (await readHwmonTemperature()) ?? (await readThermalTemperature());
};

const readFanSpeed = async () => {
	const [monitor] = await readEntries(FAN_DIR, 'hwmon');
	return (monitor ? ((await readText(path.join(FAN_DIR, monitor, 'fan1_input'))) ?? '') : '');
};

const getCpuSensors = async (module) => {
	try {
		module.setState('cpuSensors', { temperature: { main: await readCpuTemperature() }, fan: await readFanSpeed() });
	} catch (error) {
		console.error('getCpuSensors:', error);
		module.setState('cpuSensors', false);
	}
	module.nsp.emit('host:cpu:sensors', module.getState('cpuSensors'));
};

const loadHistory = async (module) => {
	history = await StatsService.getSamples(Date.now() - HISTORY_MS);
	savedUntil = (history.at(-1)?.time ?? 0);
	module.setState('stats', history);
	module.emitState('stats');
	module.registerPoller(recordSample, SAMPLE_INTERVAL_MS, { keepAlive: true, aligned: true });
	module.registerPoller(queueSave, SAVE_INTERVAL_MS, { keepAlive: true });
	module.eventEmitter.on('api:shutdown', (pending) => {
		pending.push(queueSave());
	});
};

const register = (module) => {
	module.declareState({
		cpuSensors: { event: 'host:cpu:sensors' },
		memory: { event: 'host:memory' },
		stats: { event: 'host:stats:history' }
	});
	module.setState('memory', { total: os.totalmem() });
	module.eventEmitter.on('host:network:interfaces:loaded', () => {
		defaultInterface = findDefaultInterface(module);
	});
	module.setState('stats', history);
	loadHistory(module);
};

export default {
	name: 'stats',
	register,
	pollers: [
		{ run: getCpuSensors, interval: 5000 }
	]
};
