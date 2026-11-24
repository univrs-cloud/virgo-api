import { execa } from 'execa';
import { createLog } from '../../utils/log.js';

const log = createLog('indexer:scheduled');

const index = async () => {
	try {
		await execa('virgo', ['indexer', 'index'], { stdout: 'ignore' });
	} catch (error) {
		// A pass that outlives the hourly schedule still holds the lock. That is
		// the previous run working, not a failure of this one.
		if ((error.stderr ?? '').includes('Another indexer is already running')) {
			log.info('indexer: previous run still in progress, skipping this tick.');
			return ``;
		}
		log.error('indexer failed:', error);
	}
	return ``;
};

const register = (module) => {
	module.addJobSchedule(
		'indexer:index',
		{ pattern: '0 10 * * * *' }
	);
};

export default {
	name: 'scheduled',
	register,
	jobs: {
		'indexer:index': index
	}
};
