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

	module.getNsp().emit('app:containers', module.getState('containers'));
};

module.exports = {
	name: 'polling',
	register: (module) => {
		polls.push(new Poller(module, getContainers, 2000));
	},
	startPolling: () => {
		polls.forEach((poll) => {
			poll.start();
		});
	}
};
