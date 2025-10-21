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
	if (polls[entity].polling !== null) {
		return;
	}

	const loop = async () => {
		if (plugin.getNsp().server.engine.clientsCount === 0) {
			if (!polls[entity].timeouts) {
				polls[entity].timeouts = setTimeout(() => {
					clearTimeout(polls[entity].polling);
					polls[entity].polling = null;
					polls[entity].timeouts = null;
					plugin.setState(entity, undefined);
				}, CACHE_TTL);
			}
		} else {
			if (polls[entity].timeouts) {
				clearTimeout(polls[entity].timeouts);
				polls[entity].timeouts = null;
			}
		}
		
		await polls[entity].callbacks(socket, plugin);
		if (polls[entity].polling !== null) {
			polls[entity].polling = setTimeout(loop, interval);
		}
	};

	polls[entity].polling = true;
	loop();
};

const polls = {
	containers: {
		callbacks: pollContainersOnce,
		polling: null,
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
