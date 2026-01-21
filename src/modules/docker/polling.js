const { execa } = require('execa');
const si = require('systeminformation');
const camelcaseKeys = require('camelcase-keys').default;
const docker = require('../../utils/docker_client');
const Poller = require('../../utils/poller');
const polls = [];

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

const getAppsResourceMetrics = async (module) => {
	const apps = (module.getState('configured') || []).filter((item) => { return item.type === 'app'; });
	if (apps.length === 0) {
		setTimeout(() => { getAppsResourceMetrics(module); }, 100);
		return;
	}
	
	let containers = await docker.listContainers({ all: true });
	containers = camelcaseKeys(containers, { deep: true });
	if (containers.length === 0) {
		setTimeout(() => { getAppsResourceMetrics(module); }, 100);
		return;
	}

	let appsResourceMetrics = [];
	try {
		const [dockerStats, { stdout: zfsList }] = await Promise.all([
			si.dockerContainerStats('*'),
			execa('zfs', ['list', '-o', 'used,usedbydataset,usedbysnapshots', '-j', '--json-int'])
		]);
		const containerStats = dockerStats?.map((container) => {
			return {
				id: container.id,
				cpuPercent: container.cpuPercent || 0,
				memPercent: container.memPercent || 0,
				memUsage: container.memUsage || 0
			};
		}) || [];
		const datasets = JSON.parse(zfsList)?.datasets || {};

		for (const app of apps) {
			const projectContainers = await module.findContainersByAppName(app.name);
			const appStat = projectContainers.reduce(
				(acc, container) => {
					const containerStat = containerStats.find((containerStat) => { return containerStat.id === container.id; });
					if (containerStat) {
						acc.cpuPercent += containerStat.cpuPercent;
						acc.memPercent += containerStat.memPercent;
						acc.memUsage += containerStat.memUsage;
					}
					return acc;
				},
				{ cpuPercent: 0, memPercent: 0, memUsage: 0 }
			);
			const appContainersStats = projectContainers.map(
					(container) => {
						const containerStat = containerStats.find((containerStat) => { return containerStat.id === container.id; });
						if (!containerStat) {
							return null;
						}

						return {
							id: containerStat.id,
							cpu: {
								percent: containerStat?.cpuPercent || 0
							},
							memory: {
								usage: containerStat?.memUsage || 0,
								percent: containerStat?.memPercent || 0
							}
						}
					}
				)
				.filter(Boolean);
			const dataset = Object.values(datasets).find((dataset) => { return dataset.name === `messier/apps/${app.name}`; });
			appsResourceMetrics.push({
				name: app.name,
				cpu: {
					percent: appStat?.cpuPercent || 0
				},
				memory: {
					usage: appStat?.memUsage || 0,
					percent: appStat?.memPercent || 0
				},
				storage: {
					dataset: dataset?.properties?.usedbydataset?.value || 0,
					snapshots: dataset?.properties?.usedbysnapshots?.value || 0
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
	getAppsResourceMetrics(module);

	module.eventEmitter
		.on('configured:updated', async () => {
			await getAppsResourceMetrics(module);
		});
	
	polls.push(new Poller(module, getContainers, 2000));
	polls.push(new Poller(module, getAppsResourceMetrics, 10000));
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
