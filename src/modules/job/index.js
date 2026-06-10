import BaseModule from '../base.js';
import { QUEUE_NAMES } from '../../queues.js';

// Exclude job-jobs (self) and weather-jobs from monitoring
const EXCLUDED_FROM_MONITORING = ['job-jobs', 'weather-jobs'];

class JobModule extends BaseModule {
	#queues = QUEUE_NAMES.filter((name) => {
		if (name.endsWith('-scheduled-jobs')) {
			return false;
		}
		
		return !EXCLUDED_FROM_MONITORING.includes(name);
	});

	constructor() {
		super('job');
	}

	get queues() {
		return this.#queues;
	}
}

export default () => {
	return new JobModule();
};
