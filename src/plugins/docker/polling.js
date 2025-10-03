const camelcaseKeys = require('camelcase-keys').default;
const dockerode = require('dockerode');

const docker = new dockerode();

const pollContainers = async (socket, plugin) => {
	if (plugin.getNsp().server.engine.clientsCount === 0) {
		plugin.setState('containers', undefined);
		return;
	}

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
	setTimeout(() => { pollContainers(socket, plugin); }, 2000);
};

module.exports = {
	name: 'polling',
	pollContainers
};
