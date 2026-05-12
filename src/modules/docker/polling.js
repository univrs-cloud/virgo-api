const { execa } = require('execa');
const si = require('systeminformation');
const camelcaseKeys = require('camelcase-keys').default;
const docker = require('../../utils/docker_client');
const Poller = require('../../utils/poller');
const polls = [];
let appsNetworkSnapshot = {};

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

const getAppsStorageResouceMetrics = async (module) => {
	const apps = (module.getState('configured') || []).filter((item) => { return item.type === 'app'; });
	if (apps.length === 0) {
		setTimeout(() => { getAppsStorageResouceMetrics(module); }, 100);
		return;
	}

	const datasetNameToAppName = apps.reduce((acc, app) => {
		acc[`${module.appsDataset}/${app.name}`] = app.name;
		return acc;
	}, {});
	const { stdout: zfsList } = await execa('zfs', ['list', '-o', 'used,usedbydataset,usedbysnapshots', '-j', '--json-int']);
	const datasets = JSON.parse(zfsList)?.datasets || {};
	const appsStorageResourceMetrics = {};

	for (const dataset of Object.values(datasets)) {
		const appName = datasetNameToAppName[dataset?.name];
		if (!appName) {
			continue;
		}

		appsStorageResourceMetrics[appName] = {
			dataset: dataset?.properties?.usedbydataset?.value || 0,
			snapshots: dataset?.properties?.usedbysnapshots?.value || 0
		};
	}

	module.setState('appsStorageResourceMetrics', appsStorageResourceMetrics);
};

const getAppsComputeResourceMetrics = async (module) => {
	const apps = (module.getState('configured') || []).filter((item) => { return item.type === 'app'; });
	if (apps.length === 0) {
		setTimeout(() => { getAppsComputeResourceMetrics(module); }, 100);
		return;
	}
	
	const containers = module.getState('containers');
	if (containers.length === 0) {
		setTimeout(() => { getAppsComputeResourceMetrics(module); }, 100);
		return;
	}

	let appsResourceMetrics = [];
	try {
		const dockerStats = await si.dockerContainerStats('*');
		const containersByApp = containers.reduce((acc, container) => {
			const appName = container.labels?.comDockerComposeProject;
			if (!appName) {
				return acc;
			}

			if (!acc[appName]) {
				acc[appName] = [];
			}
			acc[appName].push(container);
			return acc;
		}, {});
		const currentNetworkSnapshot = {};
		const currentTimestamp = Date.now();
		const containerStats = dockerStats?.map((container) => {
			const rxTotal = container.netIO?.rx ?? 0;
			const txTotal = container.netIO?.wx ?? 0;
			const previousSnapshot = appsNetworkSnapshot[container.id] || { rx: 0, tx: 0, timestamp: currentTimestamp };
			const elapsedSeconds = (currentTimestamp - previousSnapshot.timestamp) / 1000;

			let networkRx = 0;
			let networkTx = 0;
			if (elapsedSeconds > 0) {
				networkRx = Math.max(0, (rxTotal - previousSnapshot.rx) / elapsedSeconds);
				networkTx = Math.max(0, (txTotal - previousSnapshot.tx) / elapsedSeconds);
			}

			currentNetworkSnapshot[container.id] = {
				rx: rxTotal,
				tx: txTotal,
				timestamp: currentTimestamp
			};

			return {
				id: container.id,
				cpuPercent: container.cpuPercent || 0,
				memPercent: container.memPercent || 0,
				memUsage: container.memUsage || 0,
				networkRx,
				networkTx
			};
		}) || [];
		const statsById = new Map(containerStats.map((containerStat) => {
			return [containerStat.id, containerStat];
		}));
		appsNetworkSnapshot = currentNetworkSnapshot;
		const appsStorageResourceMetrics = module.getState('appsStorageResourceMetrics') || {};

		for (const app of apps) {
			const projectContainers = containersByApp[app.name] || [];
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
			const appStorage = appsStorageResourceMetrics[app.name] || { dataset: 0, snapshots: 0 };
			appsResourceMetrics.push({
				name: app.name,
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
					snapshots: appStorage.snapshots
				},
				containers: appContainersStats
			});
		}
		module.setState('appsResourceMetrics', appsResourceMetrics);
	} catch (error) {
		module.setState('appsResourceMetrics', false);
	}
	module.eventEmitter.emit('app:resourceMetrics:fetched');
};

const register = (module) => {
	getContainers(module);
	getAppsStorageResouceMetrics(module);
	getAppsComputeResourceMetrics(module);

	module.eventEmitter
		.on('configured:updated', async () => {
			await getAppsComputeResourceMetrics(module);
		});
	
	polls.push(new Poller(module, getContainers, 2000));
	polls.push(new Poller(module, getAppsComputeResourceMetrics, 2000));
	polls.push(new Poller(module, getAppsStorageResouceMetrics, 60000));
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
