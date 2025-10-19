const camelcaseKeys = require('camelcase-keys').default;
const dockerode = require('dockerode');

const docker = new dockerode();
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

const poll = (socket, plugin, entity, interval) => {
	if (polls[entity].polling) {
		return;
	}

	const loop = async () => {
		if (plugin.getNsp().server.engine.clientsCount === 0) {
			polls[entity].polling = false;
			if (!polls[entity].timeouts) {
				polls[entity].timeouts = setTimeout(() => {
					plugin.setState(entity, undefined);
					polls[entity].timeouts = null;
				}, CACHE_TTL);
			}
			return;
		}

		if (polls[entity].timeouts) {
			clearTimeout(polls[entity].timeouts);
			polls[entity].timeouts = null;
		}
		
		polls[entity].polling = true;
		await polls[entity].callbacks(socket, plugin);
		setTimeout(loop, interval);
	};

	loop();
};

const polls = {
	containers: {
		callbacks: pollContainersOnce,
		polling: false,
		timeouts: null
	}
};

const startPolling = (socket, plugin) => {
	poll(socket, plugin, 'containers', 2000);
};

module.exports = {
	name: 'polling',
	startPolling
};
