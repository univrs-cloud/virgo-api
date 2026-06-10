import Poller from '../../utils/poller.js';

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

export default {
	name: 'polling',
	register,
	startPolling
};
