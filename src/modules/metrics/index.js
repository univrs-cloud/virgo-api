const si = require('systeminformation');
const BaseModule = require('../base');

class MetricsModule extends BaseModule {
	#HOURS = 12;
	#INTERVAL_SECONDS = 60;
	#CPU_CORES = 4;
	#networkSpeedBytesPerSec = (1000 * 1000000) / 8;
	#defaultInterface = 'eth0';
	#pcpApiUrl = 'http://127.0.0.1:44322';

	constructor() {
		super('metrics');

		this.scaleSatCPU = 4;
		this.scaleUseDisks = 10000; // KB/s
		
		(async () => {
			await this.#loadNetworkInfo();
		})();

		this.eventEmitter
			.on('metrics:enabled', async () => {
				await this.#loadMetrics();
				for (const socket of this.nsp.sockets.values()) {
					if (socket.isAuthenticated && socket.isAdmin) {
						socket.emit('metrics', this.getState('metrics'));
					}
				}
			})
			.on('metrics:disabled', async () => {
				await this.#loadMetrics();
				for (const socket of this.nsp.sockets.values()) {
					if (socket.isAuthenticated && socket.isAdmin) {
						socket.emit('metrics', this.getState('metrics'));
					}
				}
			});
	}

	async onConnection(socket) {
		socket.on('metrics:fetch', async () => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await this.#loadMetrics();
			socket.emit('metrics', this.getState('metrics'));
		});
	}

	async isPcpRunning() {
		try {
			const response = await fetch(`${this.#pcpApiUrl}/series/ping`, {
				signal: AbortSignal.timeout(5000)
			});
			return response.ok;
		} catch (error) {
			// Try metrics endpoint as fallback (ping might not exist in all versions)
			try {
				const response = await fetch(`${this.#pcpApiUrl}/series/metrics?limit=1`, {
					signal: AbortSignal.timeout(5000)
				});
				return response.ok;
			} catch {
				return false;
			}
		}
	}

	#clamp01(value) { 
		return Math.max(0, Math.min(1, value));
	}

	#scaleForValue(x) {
		const scale = Math.pow(10, Math.floor(Math.log10(x)));
		return Math.ceil(x / scale) * scale;
	}

	/**
	 * Convert counter values to rates (value per second)
	 * Counter metrics accumulate over time, so we need to compute the delta
	 */
	#counterToRate(values) {
		if (values.length < 2) return [];
		
		const rates = [];
		for (let i = 1; i < values.length; i++) {
			const prev = values[i - 1];
			const curr = values[i];
			const timeDeltaSec = (curr.timestamp - prev.timestamp) / 1000;
			
			if (timeDeltaSec > 0) {
				const valueDelta = curr.value - prev.value;
				// Handle counter wrap-around (unlikely but possible)
				const rate = valueDelta >= 0 ? valueDelta / timeDeltaSec : 0;
				rates.push({
					timestamp: curr.timestamp,
					value: rate,
					instance: curr.instance
				});
			}
		}
		return rates;
	}

	#buildMetricGrid(values, mapFn) {
		const dataMap = new Map();
		for (const p of values) {
			const mapped = mapFn(p);
			if (mapped === null) continue;
			
			// Timestamp from API is in milliseconds, round to minute
			const d = new Date(p.timestamp);
			d.setUTCSeconds(0, 0);
			const tsMs = d.getTime();
			
			const existing = dataMap.get(tsMs);
			if (existing) {
				existing.normalized += mapped.normalized;
				// For raw, handle objects (like CPU breakdown) vs simple values
				if (typeof mapped.raw === 'object' && mapped.raw !== null) {
					for (const key of Object.keys(mapped.raw)) {
						existing.raw[key] = (existing.raw[key] ?? 0) + mapped.raw[key];
					}
				} else {
					existing.raw += mapped.raw;
				}
			} else {
				dataMap.set(tsMs, {
					normalized: mapped.normalized,
					raw: typeof mapped.raw === 'object' && mapped.raw !== null 
						? { ...mapped.raw } 
						: mapped.raw
				});
			}
		}
		// Return sorted array of [timestamp, { normalized, raw }] pairs
		return Array.from(dataMap.entries()).sort((a, b) => a[0] - b[0]);
	}

	async #getSeriesIds(metric) {
		try {
			const response = await fetch(
				`${this.#pcpApiUrl}/series/query?expr=${encodeURIComponent(metric)}`,
				{ signal: AbortSignal.timeout(10000) }
			);
			if (!response.ok) {
				console.error(`Failed to query series for ${metric}: ${response.status}`);
				return [];
			}
			return await response.json();
		} catch (error) {
			console.error(`Failed to get series IDs for ${metric}:`, error.message);
			return [];
		}
	}

	async #getSeriesInstances(seriesId) {
		try {
			const response = await fetch(
				`${this.#pcpApiUrl}/series/instances?series=${seriesId}`,
				{ signal: AbortSignal.timeout(10000) }
			);
			if (!response.ok) return [];
			return await response.json();
		} catch (error) {
			console.error(`Failed to get instances for series ${seriesId}:`, error.message);
			return [];
		}
	}

	async #pcpQuery(metric, instanceFilter = null) {
		try {
			const seriesIds = await this.#getSeriesIds(metric);
			if (seriesIds.length === 0) {
				return { values: [] };
			}
			
			const extraMinutes = new Date().getMinutes();
			const totalMinutes = this.#HOURS * 60 + extraMinutes + 1;
			const start = `-${totalMinutes}minute`;
			const finish = 'now';

			// Query all series and pick the one with the most data
			let bestValues = [];
			
			for (const seriesId of seriesIds) {
				const url = `${this.#pcpApiUrl}/series/values?series=${seriesId}&start=${start}&finish=${finish}&interval=${this.#INTERVAL_SECONDS}s`;

				const response = await fetch(url, {
					signal: AbortSignal.timeout(30000)
				});
				
				if (!response.ok) {
					continue;
				}

				let values = await response.json();
				
				// Skip empty series
				if (!values || values.length === 0) {
					continue;
				}

				// If instance filter specified, get instances and filter
				if (instanceFilter !== null) {
					const instances = await this.#getSeriesInstances(seriesId);
					const targetInstance = instances.find(i => 
						i.name === instanceFilter || i.id === instanceFilter
					);
					if (targetInstance) {
						values = values.filter(v => v.instance === targetInstance.instance);
					} else {
						continue; // This series doesn't have the requested instance
					}
				}

				if (values.length === 0) {
					continue;
				}

				// Parse values (API returns scientific notation strings)
				const parsedValues = values.map(v => ({
					timestamp: v.timestamp,
					value: parseFloat(v.value),
					instance: v.instance
				})).filter(v => !isNaN(v.value));

				// Keep the series with the most data points
				if (parsedValues.length > bestValues.length) {
					bestValues = parsedValues;
				}
			}

			// Sort by timestamp
			bestValues.sort((a, b) => a.timestamp - b.timestamp);

			return { values: bestValues };
		} catch (error) {
			console.error('Failed to query PCP metric', metric, ':', error.message);
			return { values: [] };
		}
	}

	async #loadMetrics() {
		const isEnabled = await this.isPcpRunning();
		let grid = {};

		if (isEnabled) {
			const [cpuNiceRaw, cpuUserRaw, cpuSysRaw, loadAvgRaw, memTotalRaw, memAvailRaw, swapOutRaw, diskTotalRaw, netTotalRaw] = await Promise.all([
				this.#pcpQuery('kernel.all.cpu.nice'),
				this.#pcpQuery('kernel.all.cpu.user'),
				this.#pcpQuery('kernel.all.cpu.sys'),
				this.#pcpQuery('kernel.all.load', '1 minute'), // Filter to 1-minute load
				this.#pcpQuery('mem.physmem'),
				this.#pcpQuery('mem.util.available'),
				this.#pcpQuery('swap.pagesout'),
				this.#pcpQuery('disk.all.total_bytes'),
				this.#pcpQuery('network.interface.total.bytes', this.#defaultInterface),
			]);

			// Convert counter metrics to rates
			const cpuNiceRates = this.#counterToRate(cpuNiceRaw.values);
			const cpuUserRates = this.#counterToRate(cpuUserRaw.values);
			const cpuSysRates = this.#counterToRate(cpuSysRaw.values);
			const swapOutRates = this.#counterToRate(swapOutRaw.values);
			const diskRates = this.#counterToRate(diskTotalRaw.values);
			const netRates = this.#counterToRate(netTotalRaw.values);

			// Combine CPU metrics by timestamp
			const cpuByTs = new Map();
			for (const v of cpuNiceRates) {
				cpuByTs.set(v.timestamp, { nice: v.value, user: 0, sys: 0 });
			}
			for (const v of cpuUserRates) {
				const entry = cpuByTs.get(v.timestamp) || { nice: 0, user: 0, sys: 0 };
				entry.user = v.value;
				cpuByTs.set(v.timestamp, entry);
			}
			for (const v of cpuSysRates) {
				const entry = cpuByTs.get(v.timestamp) || { nice: 0, user: 0, sys: 0 };
				entry.sys = v.value;
				cpuByTs.set(v.timestamp, entry);
			}

			const cpuUtilValues = Array.from(cpuByTs.entries()).map(([timestamp, cpu]) => ({
				timestamp,
				nice: cpu.nice || 0,
				user: cpu.user || 0,
				sys: cpu.sys || 0
			}));

			// CPU: rate is in ms/s, max is 1000ms/s per core = 100% per core
			// Total max = 1000 * numCores for all cores at 100%
			const maxCpu = 1000 * this.#CPU_CORES;
			const cpuUtil = this.#buildMetricGrid(cpuUtilValues, p => {
				const total = p.nice + p.user + p.sys;
				return {
					normalized: this.#clamp01(total / maxCpu),
					raw: {
						nice: this.#clamp01(p.nice / maxCpu),
						user: this.#clamp01(p.user / maxCpu),
						sys: this.#clamp01(p.sys / maxCpu)
					}
				};
			});

			// CPU saturation: 1-minute load average (instant metric, not counter)
			const cpuSat = this.#buildMetricGrid(loadAvgRaw.values, p => {
				const load = p.value;
				if (load > this.scaleSatCPU)
					this.scaleSatCPU = this.#scaleForValue(load);
				return {
					normalized: this.#clamp01(load / this.scaleSatCPU),
					raw: load
				};
			});

			// Memory: (total - available) / total, both in KiB (instant metrics)
			const memTotalByTs = new Map();
			for (const v of memTotalRaw.values) {
				memTotalByTs.set(v.timestamp, v.value);
			}

			const memUtil = this.#buildMetricGrid(memAvailRaw.values, p => {
				const total = memTotalByTs.get(p.timestamp);
				const avail = p.value;
				if (total && avail !== undefined) {
					const used = total - avail;
					return {
						normalized: this.#clamp01(used / total),
						raw: { used: used * 1024, total: total * 1024 } // in bytes
					};
				}
				return null;
			});

			// Memory saturation: swap pages out rate
			const memSat = this.#buildMetricGrid(swapOutRates, p => {
				const swapoutRate = p.value; // pages/s
				return {
					normalized: swapoutRate > 1000 ? 1 : (swapoutRate > 1 ? 0.3 : 0),
					raw: swapoutRate // pages/s
				};
			});

			// Disk: bytes/s rate, unbounded with dynamic scaling
			const diskUtil = this.#buildMetricGrid(diskRates, p => {
				const bytesPerSec = p.value;
				if (bytesPerSec > this.scaleUseDisks)
					this.scaleUseDisks = this.#scaleForValue(bytesPerSec);
				return {
					normalized: this.#clamp01(bytesPerSec / this.scaleUseDisks),
					raw: bytesPerSec // bytes/s
				};
			});

			// Network: bytes/s rate, normalize to interface speed
			const netUtil = this.#buildMetricGrid(netRates, p => {
				const bytesPerSec = p.value || 0;
				return {
					normalized: this.#clamp01(bytesPerSec / this.#networkSpeedBytesPerSec),
					raw: bytesPerSec // bytes/s
				};
			});

			grid = { cpuUtil, cpuSat, memUtil, memSat, diskUtil, netUtil };
		}

		const metrics = {
			isEnabled,
			grid
		};

		this.setState('metrics', metrics);
	}

	async #loadNetworkInfo() {
		try {
			const defaultInterface = await si.networkInterfaces('default');
			if (defaultInterface) {
				this.#defaultInterface = defaultInterface.iface;
				if (defaultInterface.speed > 0) {
					// systeminformation returns speed in Mbps (megabits per second)
					// Convert Mbps to bytes/second: Mbps * 1,000,000 / 8
					this.#networkSpeedBytesPerSec = (defaultInterface.speed * 1000000) / 8;
				}
			}
		} catch (error) {
			console.error('Failed to get network interface info:', error.message);
		}
		try {
			const cpu = await si.cpu();
			if (cpu.cores > 0) {
				this.#CPU_CORES = cpu.cores;
			}
		} catch (error) {
			console.error('Failed to get CPU info:', error.message);
		}
	}
}

module.exports = () => {
	return new MetricsModule();
};
