const configuration = require('./configuration');
const host = require('./host');
const docker = require('./docker');
const share = require('./share');

module.exports = (io) => {
	configuration(io);
	host(io);
	docker(io);
	share(io);
};
