const BaseModule = require('../base');

class JobModule extends BaseModule {
	#queues = ['configuration-jobs', 'host-jobs', 'docker-jobs', 'bookmark-jobs', 'user-jobs', 'share-jobs'];

	constructor() {
		super('job');
	}

	get queues() {
		return this.#queues;
	}
}

module.exports = () => {
	return new JobModule();
};
