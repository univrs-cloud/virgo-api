const fs = require('fs');
const { execa } = require('execa');
const BaseModule = require('../base');

class MetricsModule extends BaseModule {
	#HOURS = 12;
	#INTERVAL_SECONDS = 60;
	#CPU_CORES = 4;
	#networkSpeedBytesPerSec = (1000 * 1000000) / 8;
	#defaultInterface = '';
	#pcpApiUrl = 'http://127.0.0.1:44322';
	#scaleSatCPU = 4;
	#scaleUseDisks = 10000;
	#systemInfoReady;

	constructor() {
		super('metrics');

		// Store the promise so callers can await system info being loaded
		this.#systemInfoReady = this.#loadSystemInfo();

		this.eventEmitter
			.on('host:network:interface:updated', async () => {
				await this.#loadSystemInfo();
				await this.#loadMetrics();
				this.#broadcastMetrics();
			})
			.on('metrics:enabled', async () => {
				await this.#loadMetrics();
				this.#broadcastMetrics();
			})
			.on('metrics:disabled', async () => {
				await this.#loadMetrics();
				this.#broadcastMetrics();
			});
	}

	#broadcastMetrics() {
		for (const socket of this.nsp.sockets.values()) {
			if (socket.isAuthenticated && socket.isAdmin) {
				socket.emit('metrics', this.getState('metrics'));
			}
		}
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
		} catch {
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

	#snapToMinute(timestamp) {
		const d = new Date(timestamp);
		d.setUTCSeconds(0, 0);
		return d.getTime();
	}

	#counterToRate(values) {
		if (values.length < 2) {
			return [];
		}
		
		const rates = [];
		for (let i = 1; i < values.length; i++) {
			const prev = values[i - 1];
			const curr = values[i];
			const timeDeltaSec = (curr.timestamp - prev.timestamp) / 1000;
			if (timeDeltaSec > 0) {
				const valueDelta = curr.value - prev.value;
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

	/**
	 * Aggregates values into a per-minute grid.
	 * 
	 * @param {Array} values - Raw data points with timestamps
	 * @param {Function} mapFn - Maps each point to { normalized, raw } or null
	 * @param {Object} [options]
	 * @param {string} [options.aggregate='sum'] - How to combine multiple points
	 *   in the same minute bucket: 'sum' (for rates/counters) or 'average' (for gauges)
	 */
	#buildMetricGrid(values, mapFn, { aggregate = 'sum' } = {}) {
		const dataMap = new Map();
		const countMap = new Map();

		for (const p of values) {
			const mapped = mapFn(p);
			if (mapped === null) {
				continue;
			}
			
			const d = new Date(p.timestamp);
			d.setUTCSeconds(0, 0);
			const tsMs = d.getTime();
			
			const existing = dataMap.get(tsMs);
			if (existing) {
				existing.normalized += mapped.normalized;
				if (typeof mapped.raw === 'object' && mapped.raw !== null) {
					for (const key of Object.keys(mapped.raw)) {
						existing.raw[key] = (existing.raw[key] ?? 0) + mapped.raw[key];
					}
				} else {
					existing.raw += mapped.raw;
				}
				countMap.set(tsMs, (countMap.get(tsMs) || 1) + 1);
			} else {
				dataMap.set(tsMs, {
					normalized: mapped.normalized,
					raw: typeof mapped.raw === 'object' && mapped.raw !== null 
						? { ...mapped.raw } 
						: mapped.raw
				});
				countMap.set(tsMs, 1);
			}
		}

		// For gauge-type metrics, average the accumulated values instead of summing
		if (aggregate === 'average') {
			for (const [tsMs, entry] of dataMap.entries()) {
				const count = countMap.get(tsMs);
				if (count > 1) {
					entry.normalized /= count;
					if (typeof entry.raw === 'object' && entry.raw !== null) {
						for (const key of Object.keys(entry.raw)) {
							entry.raw[key] /= count;
						}
					} else {
						entry.raw /= count;
					}
				}
			}
		}

		return Array.from(dataMap.entries()).sort((a, b) => a[0] - b[0]);
	}

	async #pcpQuery(metric, instanceFilter = null, aggregateInstances = false) {
		try {
			const response = await fetch(
				`${this.#pcpApiUrl}/series/query?expr=${encodeURIComponent(metric)}`,
				{ signal: AbortSignal.timeout(10000) }
			);
			if (!response.ok) {
				return { values: [] };
			}
			
			const seriesIds = await response.json();
			if (seriesIds.length === 0) {
				return { values: [] };
			}
			
			const extraMinutes = new Date().getMinutes();
			const totalMinutes = this.#HOURS * 60 + extraMinutes + 1;
			const start = `-${totalMinutes}minute`;

			let bestValues = [];
			let targetInstance = null;
			let targetSeriesId = null;

			if (instanceFilter !== null) {
				for (const seriesId of seriesIds) {
					const instResponse = await fetch(
						`${this.#pcpApiUrl}/series/instances?series=${seriesId}`,
						{ signal: AbortSignal.timeout(10000) }
					);
					if (!instResponse.ok) {
						continue;
					}
					
					const instances = await instResponse.json();
					targetInstance = instances.find(i => 
						i.name === instanceFilter || 
						i.name?.toLowerCase() === instanceFilter?.toLowerCase()
					);
					
					if (targetInstance) {
						targetSeriesId = seriesId;
						break;
					}
				}
				
				if (!targetInstance) {
					return { values: [] };
				}
			}
			
			const seriesToQuery = targetSeriesId ? [targetSeriesId] : seriesIds;
			
			// If filtering by instance, collect values from single series
			if (instanceFilter !== null) {
				for (const seriesId of seriesToQuery) {
					const valResponse = await fetch(
						`${this.#pcpApiUrl}/series/values?series=${seriesId}&start=${start}&finish=now&interval=${this.#INTERVAL_SECONDS}s`,
						{ signal: AbortSignal.timeout(30000) }
					);
					
					if (!valResponse.ok) {
						continue;
					}

					let values = await valResponse.json();
					if (!values || values.length === 0) {
						continue;
					}

					values = values.filter(v => v.instance === targetInstance.instance);

					if (values.length === 0) {
						continue;
					}

					const parsedValues = values
						.map(v => ({
							timestamp: v.timestamp,
							value: parseFloat(v.value),
							instance: v.instance
						}))
						.filter(v => !isNaN(v.value));

					if (parsedValues.length > bestValues.length) {
						bestValues = parsedValues;
					}
				}

				bestValues.sort((a, b) => a.timestamp - b.timestamp);
				return { values: bestValues };
			}

			// If aggregateInstances is true, sum all instances (e.g., all disk devices)
			// Otherwise, take the series with the most values (e.g., memory metrics)
			if (aggregateInstances) {
				const allValuesByTimestamp = new Map();
				
				for (const seriesId of seriesToQuery) {
					const valResponse = await fetch(
						`${this.#pcpApiUrl}/series/values?series=${seriesId}&start=${start}&finish=now&interval=${this.#INTERVAL_SECONDS}s`,
						{ signal: AbortSignal.timeout(30000) }
					);
					
					if (!valResponse.ok) {
						continue;
					}

					let values = await valResponse.json();
					if (!values || values.length === 0) {
						continue;
					}

					for (const v of values) {
						const value = parseFloat(v.value);
						if (isNaN(value)) {
							continue;
						}

						const existing = allValuesByTimestamp.get(v.timestamp);
						if (existing) {
							existing.value += value;
						} else {
							allValuesByTimestamp.set(v.timestamp, {
								timestamp: v.timestamp,
								value: value,
								instance: null // Aggregated across instances
							});
						}
					}
				}

				bestValues = Array.from(allValuesByTimestamp.values());
				bestValues.sort((a, b) => a.timestamp - b.timestamp);
				return { values: bestValues };
			}

			// For non-aggregated metrics (like memory), take the series with most values
			for (const seriesId of seriesToQuery) {
				const valResponse = await fetch(
					`${this.#pcpApiUrl}/series/values?series=${seriesId}&start=${start}&finish=now&interval=${this.#INTERVAL_SECONDS}s`,
					{ signal: AbortSignal.timeout(30000) }
				);
				
				if (!valResponse.ok) {
					continue;
				}

				let values = await valResponse.json();
				if (!values || values.length === 0) {
					continue;
				}

				const parsedValues = values
					.map(v => ({
						timestamp: v.timestamp,
						value: parseFloat(v.value),
						instance: v.instance
					}))
					.filter(v => !isNaN(v.value));

				if (parsedValues.length > bestValues.length) {
					bestValues = parsedValues;
				}
			}

			bestValues.sort((a, b) => a.timestamp - b.timestamp);
			return { values: bestValues };
		} catch (error) {
			console.error('Failed to query PCP metric', metric, ':', error.message);
			return { values: [] };
		}
	}

	async #loadMetrics() {
		// Ensure system info (CPU cores, network interface) is loaded before
		// computing metrics, so we don't use stale defaults on the first call.
		await this.#systemInfoReady;

		const isEnabled = await this.isPcpRunning();
		let grid = {};
		
		if (isEnabled) {
			const [
				cpuNiceRaw, cpuUserRaw, cpuSysRaw, loadAvgRaw,
				memTotalRaw, memAvailRaw, swapOutRaw,
				diskTotalRaw, diskReadRaw, diskWriteRaw,
				netTotalRaw, netInRaw, netOutRaw
			] = await Promise.all([
				this.#pcpQuery('kernel.all.cpu.nice'),
				this.#pcpQuery('kernel.all.cpu.user'),
				this.#pcpQuery('kernel.all.cpu.sys'),
				this.#pcpQuery('kernel.all.load', '1 minute'),
				this.#pcpQuery('mem.physmem'),
				this.#pcpQuery('mem.util.available'),
				this.#pcpQuery('swap.pagesout'),
				this.#pcpQuery('disk.all.total_bytes'),
				this.#pcpQuery('disk.all.read_bytes'),
				this.#pcpQuery('disk.all.write_bytes'),
				this.#pcpQuery('network.interface.total.bytes', this.#defaultInterface),
				this.#pcpQuery('network.interface.in.bytes', this.#defaultInterface),
				this.#pcpQuery('network.interface.out.bytes', this.#defaultInterface),
			]);

			const cpuNiceRates = this.#counterToRate(cpuNiceRaw.values);
			const cpuUserRates = this.#counterToRate(cpuUserRaw.values);
			const cpuSysRates = this.#counterToRate(cpuSysRaw.values);
			const swapOutRates = this.#counterToRate(swapOutRaw.values);
			const diskRates = this.#counterToRate(diskTotalRaw.values);
			const diskReadRates = this.#counterToRate(diskReadRaw.values);
			const diskWriteRates = this.#counterToRate(diskWriteRaw.values);
			const netRates = this.#counterToRate(netTotalRaw.values);
			const netInRates = this.#counterToRate(netInRaw.values);
			const netOutRates = this.#counterToRate(netOutRaw.values);

			// Merge CPU nice/user/sys rates by minute-snapped timestamps so that
			// slight timestamp offsets between the three series don't cause misses.
			const cpuByTs = new Map();
			for (const v of cpuNiceRates) {
				const ts = this.#snapToMinute(v.timestamp);
				cpuByTs.set(ts, { nice: v.value, user: 0, sys: 0 });
			}
			for (const v of cpuUserRates) {
				const ts = this.#snapToMinute(v.timestamp);
				const entry = cpuByTs.get(ts) || { nice: 0, user: 0, sys: 0 };
				entry.user = v.value;
				cpuByTs.set(ts, entry);
			}
			for (const v of cpuSysRates) {
				const ts = this.#snapToMinute(v.timestamp);
				const entry = cpuByTs.get(ts) || { nice: 0, user: 0, sys: 0 };
				entry.sys = v.value;
				cpuByTs.set(ts, entry);
			}

			const cpuUtilValues = Array.from(cpuByTs.entries()).map(([timestamp, cpu]) => ({
				timestamp,
				nice: cpu.nice || 0,
				user: cpu.user || 0,
				sys: cpu.sys || 0
			}));

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

			// Pre-compute max load to ensure consistent normalization across all data points
			const maxLoad = loadAvgRaw.values.reduce((max, p) => Math.max(max, p.value), 0);
			if (maxLoad > this.#scaleSatCPU) {
				this.#scaleSatCPU = this.#scaleForValue(maxLoad);
			}

			const cpuSat = this.#buildMetricGrid(loadAvgRaw.values, p => {
				const load = p.value;
				return {
					normalized: this.#clamp01(load / this.#scaleSatCPU),
					raw: load
				};
			}, { aggregate: 'average' });

			// Build memTotal lookup keyed by minute-snapped timestamps for robust matching.
			// PCP may return slightly different timestamps for mem.physmem vs mem.util.available,
			// so exact timestamp matching can fail. Snapping to the minute boundary ensures
			// the two series align correctly. We also keep track of the last known total as a
			// fallback since physical memory is constant and shouldn't prevent data from showing.
			const memTotalByTs = new Map();
			let lastKnownMemTotal = null;
			for (const v of memTotalRaw.values) {
				const snappedTs = this.#snapToMinute(v.timestamp);
				memTotalByTs.set(snappedTs, v.value);
				lastKnownMemTotal = v.value;
			}

			const memUtil = this.#buildMetricGrid(memAvailRaw.values, p => {
				const snappedTs = this.#snapToMinute(p.timestamp);
				const total = memTotalByTs.get(snappedTs) ?? lastKnownMemTotal;
				const avail = p.value;
				if (total && avail !== undefined) {
					const used = total - avail;
					return {
						normalized: this.#clamp01(used / total),
						raw: { used: used * 1024, total: total * 1024 }
					};
				}
				return null;
			}, { aggregate: 'average' });

			const memSat = this.#buildMetricGrid(swapOutRates, p => {
				const swapoutRate = p.value;
				// Logarithmic scale: 1 → 0, 10 → 0.33, 100 → 0.67, 1000+ → 1
				// 5-10 pages/s is considered "frequent swapping" that impacts performance
				const normalized = swapoutRate <= 1 ? 0 : Math.min(1, Math.log10(swapoutRate) / 3);
				return {
					normalized,
					raw: swapoutRate
				};
			});

			// Pre-compute max disk I/O to ensure consistent normalization across all data points
			// disk.all.total_bytes is in KiB (despite the name), so rate is KiB/s
			const maxDiskBytesPerSec = diskRates.reduce((max, p) => Math.max(max, p.value * 1024), 0);
			if (maxDiskBytesPerSec > this.#scaleUseDisks) {
				this.#scaleUseDisks = this.#scaleForValue(maxDiskBytesPerSec);
			}

			// Build disk read/write lookup by minute-snapped timestamp so the grid
			// entries contain the breakdown alongside the total.
			const diskRwByTs = new Map();
			for (const v of diskReadRates) {
				const ts = this.#snapToMinute(v.timestamp);
				const entry = diskRwByTs.get(ts) || { read: 0, write: 0 };
				entry.read = v.value * 1024; // KiB/s → bytes/s
				diskRwByTs.set(ts, entry);
			}
			for (const v of diskWriteRates) {
				const ts = this.#snapToMinute(v.timestamp);
				const entry = diskRwByTs.get(ts) || { read: 0, write: 0 };
				entry.write = v.value * 1024; // KiB/s → bytes/s
				diskRwByTs.set(ts, entry);
			}

			const diskUtil = this.#buildMetricGrid(diskRates, p => {
				// disk.all.total_bytes is in KiB (despite the name), so rate is KiB/s
				// Convert to bytes/s for consistency with other metrics
				const kibibytesPerSec = p.value;
				const bytesPerSec = kibibytesPerSec * 1024;
				const ts = this.#snapToMinute(p.timestamp);
				const rw = diskRwByTs.get(ts) || { read: 0, write: 0 };
				return {
					normalized: this.#clamp01(bytesPerSec / this.#scaleUseDisks),
					raw: {
						total: bytesPerSec,
						read: rw.read,
						write: rw.write
					}
				};
			});

			// Build network rx/tx lookup by minute-snapped timestamp so the grid
			// entries contain the breakdown alongside the total.
			const netRxTxByTs = new Map();
			for (const v of netInRates) {
				const ts = this.#snapToMinute(v.timestamp);
				const entry = netRxTxByTs.get(ts) || { rx: 0, tx: 0 };
				entry.rx = v.value;
				netRxTxByTs.set(ts, entry);
			}
			for (const v of netOutRates) {
				const ts = this.#snapToMinute(v.timestamp);
				const entry = netRxTxByTs.get(ts) || { rx: 0, tx: 0 };
				entry.tx = v.value;
				netRxTxByTs.set(ts, entry);
			}

			const netUtil = this.#buildMetricGrid(netRates, p => {
				const bytesPerSec = p.value || 0;
				const ts = this.#snapToMinute(p.timestamp);
				const rxtx = netRxTxByTs.get(ts) || { rx: 0, tx: 0 };
				return {
					normalized: this.#clamp01(bytesPerSec / this.#networkSpeedBytesPerSec),
					raw: {
						total: bytesPerSec,
						rx: rxtx.rx,
						tx: rxtx.tx
					}
				};
			});

			grid = { cpuUtil, cpuSat, memUtil, memSat, diskUtil, netUtil };
		}

		this.setState('metrics', { isEnabled, grid });
	}

	async #getInterfaceSpeed(ifname) {
		try {
			let targetInterface = ifname;
			const bondingPath = `/sys/class/net/${ifname}/bonding/active_slave`;
			if (fs.existsSync(bondingPath)) { // Check if it's a bond interface
				const activeSlave = await fs.promises.readFile(bondingPath, 'utf8');
				if (activeSlave.trim()) {
					targetInterface = activeSlave.trim();
				}
			}
			const speed = await fs.promises.readFile(`/sys/class/net/${targetInterface}/speed`, 'utf8');
			const speedValue = parseInt(speed.trim(), 10);
			return (isNaN(speedValue) || speedValue < 0) ? 0 : speedValue;
		} catch {
			return 0;
		}
	}

	async #loadSystemInfo() {
		try {
			const { stdout: defaultRoutesOutput } = await execa('ip', ['-j', 'route', 'show', 'default']);
			const defaultRoutes = JSON.parse(defaultRoutesOutput);
			if (defaultRoutes.length > 0 && defaultRoutes[0].dev) {
				this.#defaultInterface = defaultRoutes[0].dev;
				const speed = await this.#getInterfaceSpeed(this.#defaultInterface);
				if (speed > 0) {
					this.#networkSpeedBytesPerSec = (speed * 1000000) / 8;
				}
			}
		} catch (error) {
			console.error('Failed to get network info:', error.message);
		}
		
		try {
			const cpuinfo = await fs.promises.readFile('/proc/cpuinfo', 'utf8');
			const processors = cpuinfo.match(/^processor\s*:/gm);
			if (processors && processors.length > 0) {
				this.#CPU_CORES = processors.length;
			}
		} catch (error) {
			console.error('Failed to get CPU info:', error.message);
		}
	}
}

module.exports = () => {
	return new MetricsModule();
};
