const BaseModule = require('../base');
const { QUEUE_NAMES } = require('../../queues');

// Exclude job-jobs (self) and weather-jobs from monitoring
const EXCLUDED_FROM_MONITORING = ['job-jobs', 'weather-jobs'];

class JobModule extends BaseModule {
	#queues = QUEUE_NAMES.filter((name) => !EXCLUDED_FROM_MONITORING.includes(name));

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
