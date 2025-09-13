const job = require('./job');
const configuration = require('./configuration');
const host = require('./host');
const user = require('./user');
const docker = require('./docker');
const share = require('./share');
const weather = require('./weather');

const emitters = [];

module.exports = (io) => {
	emitters.push(job(io));
	emitters.push(configuration(io));
	emitters.push(host(io));
	emitters.push(user(io));
	emitters.push(docker(io));
	emitters.push(share(io));
	emitters.push(weather(io));

	return {
		emitters
	};
};
