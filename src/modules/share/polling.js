const Poller = require('../../utils/poller');

const polls = [];

const getShares = async (module) => {
	module.eventEmitter.emit('shares:updated');
};

const register = (module) => {
	polls.push(new Poller(module, getShares, 60000));
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
