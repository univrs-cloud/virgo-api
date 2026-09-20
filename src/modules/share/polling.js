const getShares = async (module) => {
	module.eventEmitter.emit('shares:updated');
};

export default {
	name: 'polling',
	pollers: [
		{ run: getShares, interval: 60000 }
	]
};
