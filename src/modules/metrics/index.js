const { execa } = require('execa');
const si = require('systeminformation');
const BaseModule = require('../base');

class MetricsModule extends BaseModule {
	#HOURS = 12;
	#INTERVAL_SECONDS = 60;
	#CPU_CORES = 4;
	#hostname = 'localhost';
	#networkSpeedBytesPerSec = (1000 * 1000000) / 8;
	#defaultInterface = 'eth0';

	constructor() {
		super('metrics');

		this.scaleSatCPU = 4;
		this.scaleUseDisks = 10000; // KB/s
		this.scaleUseNetwork = 100000; // B/s
		
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
			const { stdout: status } = await execa('systemctl', ['is-active', 'pmcd']);
			if (status.trim() === 'active') {
				return true;
			}
		} catch (error) {}
		try {
			await execa('pgrep', ['pmcd']);
			return true;
		} catch (error) {}
		return false;
	}

	#clamp01(value) { 
		return Math.max(0, Math.min(1, value));
	}

	#scaleForValue(x) {
		const scale = Math.pow(10, Math.floor(Math.log10(x)));
		return Math.ceil(x / scale) * scale;
	}

	#emptyGrid(startTime, endTime) {
		const grid = {};
		
		// Iterate minute by minute through the time window
		const current = new Date(startTime);
		// Round down to the nearest minute
		current.setUTCSeconds(0, 0);
		
		while (current <= endTime) {
			const hour = current.getUTCHours();
			const minute = current.getUTCMinutes();
			
			if (!grid[hour]) {
				grid[hour] = {};
			}
			grid[hour][minute] = null;
			
			// Advance by 1 minute
			current.setUTCMinutes(current.getUTCMinutes() + 1);
		}
		
		return grid;
	}

	#buildMetricGrid(series, mapFn, startTime, endTime) {
		const grid = this.#emptyGrid(startTime, endTime);
		for (const p of series.values ?? []) {
			const d = new Date(p.ts * 1000);
			const hour = d.getUTCHours();
			const minute = d.getUTCMinutes();
			const mappedValue = mapFn(p);
			if (mappedValue !== null && grid[hour] !== undefined) {
				grid[hour][minute] = (grid[hour][minute] ?? 0) + mappedValue;
			}
		}
		return grid;
	}

	async #pcpQuery(metric) {
		// Cache archives list to avoid repeated filesystem lookups
		if (!this._archivesCache) {
			this._archivesCache = await this.#findArchives();
		}
		const archives = this._archivesCache;
		
		if (!archives || archives.length === 0) {
			console.error('No PCP archives found. Ensure pmlogger is running.');
			return { values: [] };
		}

		try {
			const endTime = new Date();
			const startTime = new Date(endTime.getTime() - this.#HOURS * 3600 * 1000);
			const formatTime = (date) => {
				const pad = (n) => String(n).padStart(2, '0');
				return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
			};
			const { stdout } = await execa('pmval', [
				'-a', archives.join(','),
				'-S', formatTime(startTime),
				'-T', formatTime(endTime),
				'-t', `${this.#INTERVAL_SECONDS}sec`,
				'-f', '6',
				'-w', '20',
				'-z',
				metric
			]);
			return this.#parsePmvalOutput(stdout, startTime, endTime);
		} catch (error) {
			console.error('Failed to query PCP metric', metric, ':', error.message);
			return { values: [] };
		}
	}

	async #findArchives() {
		try {
			const archivePath = `/var/log/pcp/pmlogger/${this.#hostname}`;
			const endTime = new Date();
			const startTime = new Date(endTime.getTime() - this.#HOURS * 3600 * 1000);
			const addDateStr = (d) => {
				return d.getUTCFullYear() + 
					String(d.getUTCMonth() + 1).padStart(2, '0') + 
					String(d.getUTCDate()).padStart(2, '0');
			};
			const archiveDates = new Set([addDateStr(startTime), addDateStr(endTime)]);
			
			const { stdout } = await execa('find', [
				archivePath, '-type', 'f',
				'(', '-name', '*.meta', '-o', '-name', '*.meta.xz', ')',
				'-printf', '%p\n'
			]);

			const allArchives = stdout.split('\n')
				.filter(Boolean)
				.map(path => path.replace('.meta.xz', '').replace('.meta', ''));
			
			const relevantArchives = allArchives.filter(archive => {
				const basename = archive.split('/').pop();
				return archiveDates.has(basename.substring(0, 8));
			});
			
			return [...new Set(relevantArchives)].sort();
		} catch (error) {
			console.error('Failed to find archives:', error.message);
			return null;
		}
	}

	#parsePmvalOutput(stdout, startTime, endTime) {
		const values = [];
		const lines = stdout.split('\n');
		const endDate = new Date(endTime);
		const daysDiff = Math.ceil((endDate.getTime() - startTime.getTime()) / (24 * 3600 * 1000));
		
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || /metric:|host:|semantics:|units:|samples:/.test(trimmed)) continue;
			
			const match = trimmed.match(/^(\d{2}):(\d{2}):(\d{2})\.?\d*\s+([\d.eE+-]+)/);
			if (match) {
				const [, h, m, s, valueStr] = match;
				const value = parseFloat(valueStr);
				if (isNaN(value)) continue;
				
				const hour = parseInt(h), minute = parseInt(m), second = parseInt(s);
				
				for (let daysBack = 0; daysBack <= daysDiff + 1; daysBack++) {
					const candidate = new Date(Date.UTC(
						endDate.getUTCFullYear(), endDate.getUTCMonth(),
						endDate.getUTCDate() - daysBack, hour, minute, second
					));
					
					if (candidate >= startTime && candidate <= endTime) {
						values.push({ ts: Math.floor(candidate.getTime() / 1000), value });
						break;
					}
				}
			}
		}
		
		values.sort((a, b) => a.ts - b.ts);
		return { values };
	}

	async #loadMetrics() {
		const isEnabled = await this.isPcpRunning();
		let grid = {};

		if (isEnabled) {
			const endTime = new Date();
			const startTime = new Date(endTime.getTime() - this.#HOURS * 3600 * 1000);
			
			// Clear archive cache for fresh lookup
			this._archivesCache = null;

			const [cpuNiceRaw, cpuUserRaw, cpuSysRaw, loadAvgRaw, memTotalRaw, memAvailRaw, swapOutRaw, diskTotalRaw, netTotalRaw] = await Promise.all([
				this.#pcpQuery('kernel.all.cpu.nice'),                                      // CPU nice time
				this.#pcpQuery('kernel.all.cpu.user'),                                      // CPU user time  
				this.#pcpQuery('kernel.all.cpu.sys'),	                                    // CPU system time
				this.#pcpQuery('kernel.all.load'),	                                        // Load average (instances: 1min, 5min, 15min)
				this.#pcpQuery('mem.physmem'),		                                        // Total physical memory (KiB)
				this.#pcpQuery('mem.util.available'),	                                    // Available memory (KiB)
				this.#pcpQuery('swap.pagesout'),		                                    // Swap pages out
				this.#pcpQuery('disk.all.total_bytes'),                                     // Disk throughput (despite name, unit is KiB!)
				this.#pcpQuery(`network.interface.total.bytes[${this.#defaultInterface}]`), // Network throughput for default interface (B/s)
			]);

			const cpuUtilRaw = {
				values: cpuNiceRaw.values.map((v, i) => ({
					ts: v.ts,
					value: (v.value || 0) + (cpuUserRaw.values[i]?.value || 0) + (cpuSysRaw.values[i]?.value || 0),
				}))
			};

			// CPU: msec/s → percentage, divide by 10 to get percentage, then by numCpu
			const cpuUtil = this.#buildMetricGrid(cpuUtilRaw, p => {
				const val = p.value / 10 / this.#CPU_CORES;
				return this.#clamp01(val);
			}, startTime, endTime);

			// CPU saturation: load average (use 1min load - instance index 1)
			const cpuSat = this.#buildMetricGrid(loadAvgRaw, p => {
				// loadAvg has 3 instances: [15min, 1min, 5min], pick 1min (index 1)
				const load = Array.isArray(p.value) ? p.value[1] : p.value;
				if (load > this.scaleSatCPU)
					this.scaleSatCPU = this.#scaleForValue(load);
				return this.#clamp01(load / this.scaleSatCPU);
			}, startTime, endTime);

			// Memory: (total - available) / total, both in KiB
			const memUtil = this.#buildMetricGrid(memAvailRaw, p => {
				// We need both total and available; assume memTotalRaw has same timestamps
				const idx = memAvailRaw.values.indexOf(p);
				const total = memTotalRaw.values[idx]?.value;
				const avail = p.value;
				if (total && avail !== undefined) {
					return this.#clamp01(1 - (avail / total));
				}
				return null;
			}, startTime, endTime);

			// Memory saturation: swap pages out, categorized
			const memSat = this.#buildMetricGrid(swapOutRaw, p => {
				const swapout = p.value;
				return swapout > 1000 ? 1 : (swapout > 1 ? 0.3 : 0);
			}, startTime, endTime);

			// Disk: KiB/s (despite metric name saying "bytes"), unbounded with dynamic scaling
			const diskUtil = this.#buildMetricGrid(diskTotalRaw, p => {
				const kbps = p.value;
				if (kbps > this.scaleUseDisks)
					this.scaleUseDisks = this.#scaleForValue(kbps);
				return this.#clamp01(kbps / this.scaleUseDisks);
			}, startTime, endTime);

			// Network: B/s, normalize to detected interface speed
			const netUtil = this.#buildMetricGrid(netTotalRaw, p => {
				const bps = p.value || 0;
				return this.#clamp01(bps / this.#networkSpeedBytesPerSec);
			}, startTime, endTime);

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
			const osInfo = await si.osInfo();
			this.#hostname = osInfo.hostname;
		} catch (error) {
			console.error('Failed to get hostname info:', error.message);
		}
	}
}

module.exports = () => {
	return new MetricsModule();
};
