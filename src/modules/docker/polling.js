import { execa } from 'execa';
import camelcaseKeys from 'camelcase-keys';
import docker from '../../utils/docker_client.js';

const EVENTS_RECONNECT_DELAY_MS = 5000;
const CONTAINERS_DEBOUNCE_MS = 250;

let containersSnapshot = {};
let containersTimer = null;
let appsStorageRetry = null;

const getContainers = async (module) => {
	try {
		let containers = await docker.listContainers({ all: true });
		containers = camelcaseKeys(containers, { deep: true });
		module.setState('containers', containers);
	} catch (error) {
		module.setState('containers', false);
	}
	module.eventEmitter.emit('app:containers:fetched');
};

const scheduleContainers = (module) => {
	clearTimeout(containersTimer);
	containersTimer = setTimeout(() => {
		getContainers(module);
	}, CONTAINERS_DEBOUNCE_MS);
};

const watchContainerEvents = async (module) => {
	let isReconnecting = false;
	const reconnect = () => {
		if (isReconnecting) {
			return;
		}

		isReconnecting = true;
		setTimeout(() => {
			watchContainerEvents(module);
		}, EVENTS_RECONNECT_DELAY_MS);
	};

	try {
		const stream = await docker.getEvents({ filters: { type: ['container'] } });
		let buffer = '';
		stream.on('data', (chunk) => {
			buffer += chunk.toString('utf8');
			const lines = buffer.split('\n');
			buffer = lines.pop();
			for (const line of lines.filter(Boolean)) {
				try {
					const event = JSON.parse(line);
					if (!(event.Action ?? event.status ?? '').toLowerCase().startsWith('exec_')) {
						scheduleContainers(module);
					}
				} catch (error) {
					console.error('watchContainerEvents:', error);
				}
			}
		});
		stream.on('end', reconnect);
		stream.on('error', reconnect);
		getContainers(module);
	} catch (error) {
		console.error('watchContainerEvents:', error);
		reconnect();
	}
};

const getAppsStorageResouceMetrics = async (module) => {
	if (!Array.isArray(module.getState('configured'))) {
		if (!appsStorageRetry) {
			appsStorageRetry = setTimeout(() => {
				appsStorageRetry = null;
				getAppsStorageResouceMetrics(module);
			}, 2000);
		}
		return;
	}

	const appsDatasetPrefix = `${module.appsDataset}/`.toLowerCase();
	let datasets = {};
	try {
		const { stdout: zfsList } = await execa('zfs', ['list', '-o', 'used,usedbydataset,usedbysnapshots,logicalused', '-j', '--json-int']);
		datasets = JSON.parse(zfsList || '{}')?.datasets || {};
	} catch (error) {
		console.warn(`Could not read app storage metrics: ${error.message}`);
		return;
	}
	const appsStorageResourceMetrics = {};

	for (const dataset of Object.values(datasets)) {
		const datasetName = dataset?.name;
		if (!datasetName?.toLowerCase().startsWith(appsDatasetPrefix)) {
			continue;
		}

		const appName = datasetName.slice(appsDatasetPrefix.length);
		if (!appName || appName.includes('/')) {
			continue;
		}

		const used = dataset?.properties?.used?.value || 0;
		const logicalUsed = dataset?.properties?.logicalused?.value || 0;
		appsStorageResourceMetrics[appName] = {
			dataset: dataset?.properties?.usedbydataset?.value || 0,
			snapshots: dataset?.properties?.usedbysnapshots?.value || 0,
			compressratio: (used > 0 ? logicalUsed / used : 0),
			savedbycompression: Math.max(logicalUsed - used, 0)
		};
	}

	module.setState('appsStorageResourceMetrics', appsStorageResourceMetrics);
};

const getContainerStats = async (container) => {
	try {
		return { ...(await docker.getContainer(container.id).stats({ stream: false, 'one-shot': true })), id: container.id };
	} catch (error) {
		return null;
	}
};

const hasResourceMetricsWatchers = (module) => {
	return [...module.nsp.sockets.values()].some((socket) => {
		return socket.data.isWatchingResourceMetrics && module.matches(socket, 'admin');
	});
};

const watchResourceMetrics = async (isWatching, socket, module) => {
	socket.data.isWatchingResourceMetrics = Boolean(isWatching);
	if (socket.data.isWatchingResourceMetrics) {
		await getAppsComputeResourceMetrics(module);
	}
	return { status: 'succeeded' };
};

const getAppsComputeResourceMetrics = async (module) => {
	if (!hasResourceMetricsWatchers(module)) {
		return;
	}

	const configured = module.getState('configured');
	if (!Array.isArray(configured)) {
		return;
	}

	const apps = configured.filter((item) => { return item.type === 'app'; });
	
	const containers = module.getState('containers');
	if (!Array.isArray(containers) || containers.length === 0) {
		return;
	}

	let appsResourceMetrics = [];
	try {
		const runningContainers = containers.filter((container) => { return container.state?.toLowerCase() === 'running'; });
		const dockerStats = (await Promise.all(runningContainers.map(getContainerStats))).filter(Boolean);
		const containersByApp = containers.reduce((acc, container) => {
			const appName = container.labels?.comDockerComposeProject || container.id;
			if (!acc[appName]) {
				acc[appName] = [];
			}
			acc[appName].push(container);
			return acc;
		}, {});
		const currentSnapshot = {};
		const currentTimestamp = Date.now();
		const containerStats = dockerStats.map((stats) => {
			const { rx: rxTotal, tx: txTotal } = networkTotals(stats.networks);
			const cpuTotal = (stats.cpu_stats?.cpu_usage?.total_usage ?? 0);
			const systemTotal = (stats.cpu_stats?.system_cpu_usage ?? 0);
			const previousSnapshot = containersSnapshot[stats.id] || { rx: 0, tx: 0, cpu: cpuTotal, system: systemTotal, timestamp: currentTimestamp };
			const elapsedSeconds = (currentTimestamp - previousSnapshot.timestamp) / 1000;

			let networkRx = 0;
			let networkTx = 0;
			if (elapsedSeconds > 0) {
				networkRx = Math.max(0, (rxTotal - previousSnapshot.rx) / elapsedSeconds);
				networkTx = Math.max(0, (txTotal - previousSnapshot.tx) / elapsedSeconds);
			}

			const cpuDelta = cpuTotal - previousSnapshot.cpu;
			const systemDelta = systemTotal - previousSnapshot.system;
			const onlineCpus = (stats.cpu_stats?.online_cpus || stats.cpu_stats?.cpu_usage?.percpu_usage?.length || 1);
			const memUsage = (stats.memory_stats?.usage ?? 0);
			const memLimit = (stats.memory_stats?.limit ?? 0);

			currentSnapshot[stats.id] = {
				rx: rxTotal,
				tx: txTotal,
				cpu: cpuTotal,
				system: systemTotal,
				timestamp: currentTimestamp
			};

			return {
				id: stats.id,
				cpuPercent: (cpuDelta > 0 && systemDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0),
				memPercent: (memLimit > 0 ? (memUsage / memLimit) * 100 : 0),
				memUsage,
				networkRx,
				networkTx
			};
		});
		const statsById = new Map(containerStats.map((containerStat) => {
			return [containerStat.id, containerStat];
		}));
		containersSnapshot = currentSnapshot;
		const appsStorageResourceMetrics = module.getState('appsStorageResourceMetrics') || {};

		const names = [...new Set([...apps.map((app) => { return app.name; }), ...Object.keys(containersByApp)])];
		for (const name of names) {
			const projectContainers = containersByApp[name] || [];
			const appStat = { cpuPercent: 0, memPercent: 0, memUsage: 0, networkRx: 0, networkTx: 0 };
			const appContainersStats = [];

			for (const container of projectContainers) {
				const containerStat = statsById.get(container.id);
				if (!containerStat) {
					continue;
				}

				appStat.cpuPercent += containerStat.cpuPercent;
				appStat.memPercent += containerStat.memPercent;
				appStat.memUsage += containerStat.memUsage;
				appStat.networkRx += containerStat.networkRx;
				appStat.networkTx += containerStat.networkTx;

				appContainersStats.push({
					id: containerStat.id,
					cpu: {
						percent: containerStat.cpuPercent || 0
					},
					memory: {
						usage: containerStat.memUsage || 0,
						percent: containerStat.memPercent || 0
					},
					network: {
						rx: containerStat.networkRx || 0,
						tx: containerStat.networkTx || 0
					}
				});
			}
			const appStorage = appsStorageResourceMetrics[name] || { dataset: 0, snapshots: 0, compressratio: 0, savedbycompression: 0 };
			appsResourceMetrics.push({
				name,
				cpu: {
					percent: appStat?.cpuPercent || 0
				},
				memory: {
					usage: appStat?.memUsage || 0,
					percent: appStat?.memPercent || 0
				},
				network: {
					rx: appStat?.networkRx || 0,
					tx: appStat?.networkTx || 0
				},
				storage: {
					dataset: appStorage.dataset,
					snapshots: appStorage.snapshots,
					compressratio: appStorage.compressratio,
					savedbycompression: appStorage.savedbycompression
				},
				containers: appContainersStats
			});
		}
		module.setState('appsResourceMetrics', appsResourceMetrics);
	} catch (error) {
		module.setState('appsResourceMetrics', false);
	}
	module.eventEmitter.emit('app:resourceMetrics:fetched');

	function networkTotals(networks) {
		return Object.values(networks || {}).reduce((totals, network) => {
			return { rx: totals.rx + (Number(network?.rx_bytes) || 0), tx: totals.tx + (Number(network?.tx_bytes) || 0) };
		}, { rx: 0, tx: 0 });
	}
};

const register = (module) => {
	watchContainerEvents(module);
	getAppsStorageResouceMetrics(module);
	getAppsComputeResourceMetrics(module);

	module.eventEmitter
		.on('configured:updated', async () => {
			await getAppsComputeResourceMetrics(module);
		});
	
};

export default {
	name: 'polling',
	register,
	commands: {
		'app:resourceMetrics:watch': { handler: watchResourceMetrics }
	},
	pollers: [
		{ run: getAppsComputeResourceMetrics, interval: 2000 },
		{ run: getAppsStorageResouceMetrics, interval: 60000 }
	]
};
