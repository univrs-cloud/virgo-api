const host = require('./host');
const docker = require('./docker');
const share = require('./share');

module.exports = (io) => {
	host(io);
	docker(io);
	share(io);
};
