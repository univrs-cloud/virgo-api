const host = require('./host');
const docker = require('./docker');

module.exports = (io) => {
	host(io);
	docker(io);
};
