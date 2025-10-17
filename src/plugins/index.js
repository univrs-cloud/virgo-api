const initializeDatabase = require('../database/init');

module.exports = async () => {
	await initializeDatabase();
	
	const plugins = [
		require('./job')(),
		require('./configuration')(),
		require('./host')(),
		require('./user')(),
		require('./docker')(),
		require('./bookmark')(),
		require('./share')(),
		require('./weather')()
	];

	return {
		plugins
	};
};
