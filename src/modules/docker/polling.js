const { execa } = require('execa');
const camelcaseKeys = require('camelcase-keys').default;
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

	module.nsp.emit('app:containers', module.getState('containers'));
};

const getAppsResourceMetrics = async (module) => {
	let appsResourceMetrics = [];
	let apps = (module.getState('configured') || []).filter((item) => { return item.type === 'app'; });
	try {
		const { stdout: zfsList } = await execa('zfs', ['list', '-o', 'used,usedbydataset,usedbysnapshots', '-j', '--json-int'], { reject: false });
		const datasets = JSON.parse(zfsList)?.datasets || {};
		for (const app of apps) {
			const dataset = Object.values(datasets).find((dataset) => { return dataset.name === `messier/apps/${app.name}`; });
			appsResourceMetrics.push({
				name: app.name,
				cpu: 0,
				ram: 0,
				storage: {
					dataset: dataset?.properties?.usedbydataset?.value ?? 0,
					snapshots: dataset?.properties?.usedbysnapshots?.value ?? 0
				}
			});
		}
		module.setState('appsResourceMetrics', appsResourceMetrics);
	} catch (error) {
		module.setState('appsResourceMetrics', false);
	}

	module.nsp.emit('app:resourceMetrics', module.getState('appsResourceMetrics'));
};

module.exports = {
	name: 'polling',
	register: (module) => {
		polls.push(new Poller(module, getContainers, 2000));
		polls.push(new Poller(module, getAppsResourceMetrics, 10000));
	},
	startPolling: () => {
		polls.forEach((poll) => {
			poll.start();
		});
	}
};
