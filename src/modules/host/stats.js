import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { execa } from 'execa';
import si from 'systeminformation';
import StatsService from '../../database/stats_service.js';

const SAMPLE_INTERVAL_MS = 1000;
const FLUSH_INTERVAL_MS = 60 * 1000;
const HISTORY_MS = 60 * 60 * 1000;
const MEMINFO_FILE = '/proc/meminfo';
const NETWORK_DIR = '/sys/class/net';

let history = [];
let flushedUntil = 0;
let previous = null;
let isFlushing = false;

const flush = async () => {
	if (isFlushing) {
		return;
	}

	isFlushing = true;
	try {
		const pending = history.filter((sample) => { return sample.time > flushedUntil; });
		if (await StatsService.saveSamples(pending, Date.now() - HISTORY_MS)) {
			flushedUntil = (pending.at(-1)?.time ?? flushedUntil);
		}
	} finally {
		isFlushing = false;
	}
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

const readNetworkBytes = async (module) => {
	const system = module.getState('system');
	const iface = system?.networkInterfaces?.find((networkInterface) => { return networkInterface.default; })?.ifname;
	if (!iface) {
		return null;
	}

	try {
		const [rx, tx] = await Promise.all(['rx_bytes', 'tx_bytes'].map(async (counter) => {
			return Number(await fs.readFile(path.join(NETWORK_DIR, iface, 'statistics', counter), 'utf8'));
		}));
		return { iface, rx, tx };
	} catch (error) {
		return null;
	}
};

const getRate = (current, last, seconds) => {
	if (!current || !last || current.iface !== last.iface || seconds <= 0) {
		return { rx: 0, tx: 0 };
	}

	return {
		rx: Math.round(Math.max(current.rx - last.rx, 0) / seconds),
		tx: Math.round(Math.max(current.tx - last.tx, 0) / seconds)
	};
};

const sample = async (module) => {
	try {
		const now = Date.now();
		const [memory, network] = await Promise.all([readMemory(), readNetworkBytes(module)]);
		const current = { now, cpu: readCpuTimes(), network };
		if (previous) {
			const total = current.cpu.total - previous.cpu.total;
			const busy = current.cpu.busy - previous.cpu.busy;
			const { rx, tx } = getRate(current.network, previous.network, (now - previous.now) / 1000);
			const entry = {
				time: Math.round(now / 1000) * 1000,
				cpu: (total > 0 ? Math.round((busy / total) * 1000) / 10 : 0),
				memory: memory.used,
				rx,
				tx
			};
			history.push(entry);
			while (history.length > 0 && history[0].time <= now - HISTORY_MS) {
				history.shift();
			}
			module.setState('stats', history);
			module.nsp.emit('host:stats', entry);
		}
		previous = current;
	} catch (error) {
		console.error('sampleStats:', error);
	}
};

const getCpuSensors = async (module) => {
	try {
		const temperature = await si.cpuTemperature();
		const { stdout: fan } = await execa('cat /sys/devices/platform/cooling_fan/hwmon/hwmon*/fan1_input || true', { shell: true });
		module.setState('cpuStats', { temperature, fan: (fan ? fan.trim() : '') });
	} catch (error) {
		console.error('getCpuSensors:', error);
		module.setState('cpuStats', false);
	}
	module.nsp.emit('host:cpu:stats', module.getState('cpuStats'));
};

const start = async (module) => {
	history = await StatsService.getSamples(Date.now() - HISTORY_MS);
	flushedUntil = (history.at(-1)?.time ?? 0);
	module.setState('stats', history);
	module.registerPoller(sample, SAMPLE_INTERVAL_MS, { keepAlive: true, aligned: true });
	module.registerPoller(flush, FLUSH_INTERVAL_MS, { keepAlive: true });
	process.on('SIGTERM', flush);
	process.on('SIGINT', flush);
};

const register = (module) => {
	module.declareState({
		cpuStats: { event: 'host:cpu:stats' },
		memory: { event: 'host:memory' },
		stats: { event: 'host:stats:history' }
	});
	module.setState('memory', { total: os.totalmem() });
	module.setState('stats', history);
	start(module)
		.catch((error) => { console.error('startStats:', error); });
};

export default {
	name: 'stats',
	register,
	pollers: [
		{ run: getCpuSensors, interval: 5000 }
	]
};
