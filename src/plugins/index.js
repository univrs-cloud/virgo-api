const initializeDatabase = require('../database/init');

module.exports = async (io) => {
	await initializeDatabase();
	
	const plugins = [];
	plugins.push(require('./job')(io));
	plugins.push(require('./configuration')(io));
	plugins.push(require('./host')(io));
	plugins.push(require('./user')(io));
	plugins.push(require('./docker')(io));
	plugins.push(require('./bookmark')(io));
	plugins.push(require('./share')(io));
	plugins.push(require('./weather')(io));

	return {
		plugins
	};
};
