const camelcaseKeys = require('camelcase-keys').default;
const { time } = require('console');
const dockerode = require('dockerode');

const docker = new dockerode();
const polling = {
	containers: false
};
const timeouts = {
	containers: null
};
const CACHE_TTL = 1 * 60 * 1000; // 1 minute in ms

const pollContainersOnce = async (socket, plugin) => {
	try {
		let containers = await docker.listContainers({ all: true });
		containers = camelcaseKeys(containers, { deep: true });
		containers = containers.map((container) => {
			container.name = container.names[0].replace('/', '');
			return container;
		});
		plugin.setState('containers', containers);
	} catch (error) {
		plugin.setState('containers', false);
	}

	plugin.getNsp().emit('app:containers', plugin.getState('containers'));
};

const pollContainers = async (socket, plugin) => {
	if (polling.containers) {
		return;
	}

	const loop = async () => {
		if (plugin.getNsp().server.engine.clientsCount === 0) {
			polling.containers = false;
			if (!timeouts.containers) {
				timeouts.containers = setTimeout(() => {
					plugin.setState('containers', undefined);
					timeouts.containers = null;
				}, CACHE_TTL);
			}
			return;
		}

		if (timeouts.containers) {
			clearTimeout(timeouts.containers);
			timeouts.containers = null;
		}
		
		polling.containers = true;
		await pollContainersOnce(socket, plugin);
		setTimeout(loop, 2000);
	};

	loop();
};

const startPolling = async (socket, plugin) => {
	await pollContainers(socket, plugin);
};

module.exports = {
	name: 'polling',
	startPolling
};
