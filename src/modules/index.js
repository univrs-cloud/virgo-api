const { cleanupQueues } = require('../queues');

module.exports = async () => {
	await cleanupQueues();

	const modules = [
		require('./job')(),
		require('./configuration')(),
		require('./host')(),
		require('./user')(),
		require('./docker')(),
		require('./bookmark')(),
		require('./share')(),
		require('./indexer')(),
		require('./weather')()
	];

	return {
		modules
	};
};
