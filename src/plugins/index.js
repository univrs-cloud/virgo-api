const job = require('./job');
const configuration = require('./configuration');
const host = require('./host');
const user = require('./user');
const docker = require('./docker');
const share = require('./share');
const weather = require('./weather');
const initializeDatabase = require('../database/init');

module.exports = async (io) => {
	await initializeDatabase();
	
	const plugins = [];
	
	plugins.push(job(io));
	plugins.push(configuration(io));
	plugins.push(host(io));
	plugins.push(user(io));
	plugins.push(docker(io));
	plugins.push(share(io));
	plugins.push(weather(io));

	return {
		plugins
	};
};
