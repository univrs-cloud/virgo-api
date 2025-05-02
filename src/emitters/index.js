const job = require('./job');
const configuration = require('./configuration');
const host = require('./host');
const user = require('./user');
const docker = require('./docker');
const share = require('./share');

module.exports = (io) => {
	job(io);
	configuration(io);
	host(io);
	user(io);
	docker(io);
	share(io);
};
