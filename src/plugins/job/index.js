const BasePlugin = require('../base');

class JobPlugin extends BasePlugin {
	#queues = ['configuration-jobs', 'host-jobs', 'docker-jobs', 'bookmark-jobs', 'user-jobs', 'share-jobs'];

	constructor(io) {
		super(io, 'job');
	}

	get queues() {
		return this.#queues;
	}
}

module.exports = (io) => {
	return new JobPlugin(io);
};
