const { execa } = require('execa');
const camelcaseKeys = require('camelcase-keys').default;
const filesizeParser = require('filesize-parser');
const dockerode = require('dockerode');
const Poller = require('../../utils/poller');

const docker = new dockerode();
const polls = [];

const getContainers = async (module) => {
	try {
		let containers = await docker.listContainers({ all: true });
		containers = camelcaseKeys(containers, { deep: true });
		containers = containers.map((container) => {
			container.name = container.names[0].replace('/', '');
			return container;
		});
		module.setState('containers', containers);
	} catch (error) {
		module.setState('containers', false);
	}
	module.eventEmitter.emit('app:containers:fetched');
};

const getAppsResourceMetrics = async (module) => {
	const apps = (module.getState('configured') || []).filter((item) => { return item.type === 'app'; });
	const containers = module.getState('containers') || [];
	if (apps.length === 0 || containers.length === 0) {
		setTimeout(() => { getAppsResourceMetrics(module); }, 100);
		return;
	}

	let appsResourceMetrics = [];
	try {
		const { stdout: dockerStats } = await execa('docker', ['container', 'stats', '--all', '--no-stream', '--no-trunc', '--format', 'json'], { reject: false });
		const containerStats = dockerStats.split('\n')?.map((line) => { return JSON.parse(line); })?.map((stat) => {
			stat.CPUPerc = Number(stat.CPUPerc.replace('%', ''));
			stat.MemPerc = Number(stat.MemPerc.replace('%', ''));
			stat.MemUsage = filesizeParser(stat.MemUsage.split('/')[0].trim());
			return camelcaseKeys(stat);
		});
		const { stdout: zfsList } = await execa('zfs', ['list', '-o', 'used,usedbydataset,usedbysnapshots', '-j', '--json-int'], { reject: false });
		const datasets = JSON.parse(zfsList)?.datasets || {};

		for (const app of apps) {
			const container = containers.find((container) => { return container.names.includes(`/${app.name}`); });
			let projectContainers = [];
			if (container) {
				const composeProject = container?.labels?.comDockerComposeProject || false;
				if (composeProject) {
					projectContainers = containers.filter((container) => {
						return container.labels && container.labels['comDockerComposeProject'] === composeProject;
					});
				} else {
					projectContainers = [container];
				}
			}

			const appStat = projectContainers.reduce(
				(acc, container) => {
					const containerStat = containerStats.find((containerStat) => { return containerStat.id === container.id; });
					if (containerStat) {
						acc.cpuPerc += containerStat.cpuPerc;
						acc.memPerc += containerStat.memPerc;
						acc.memUsage += containerStat.memUsage;
					}
					return acc;
				},
				{ cpuPerc: 0, memPerc: 0, memUsage: 0 }
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
								percent: containerStat?.cpuPerc || 0
							},
							memory: {
								usage: containerStat?.memUsage || 0,
								percent: containerStat?.memPerc || 0
							}
						}
					}
				)
				.filter(Boolean);
			const dataset = Object.values(datasets).find((dataset) => { return dataset.name === `messier/apps/${app.name}`; });
			appsResourceMetrics.push({
				name: app.name,
				cpu: {
					percent: appStat?.cpuPerc || 0
				},
				memory: {
					usage: appStat?.memUsage || 0,
					percent: appStat?.memPerc || 0
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
	getAppsResourceMetrics(module);

	module.eventEmitter
		.on('configured:updated', async () => {
			await getAppsResourceMetrics(module);
		});
	
	polls.push(new Poller(module, getContainers, 2000));
	polls.push(new Poller(module, getAppsResourceMetrics, 60000));
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
