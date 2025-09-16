const BasePlugin = require('./base');

class JobPlugin extends BasePlugin {
	constructor(io) {
		super(io, 'job');
	}

	init() {
		this.queues = ['configuration-jobs', 'host-jobs', 'docker-jobs', 'user-jobs', 'share-jobs'];
	}
}

module.exports = (io) => {
	return new JobPlugin(io);
};
