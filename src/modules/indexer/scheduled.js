import { execa } from 'execa';

const index = async (job, module) => {
	try {
		await execa('virgo', ['indexer', 'index'], { stdout: 'ignore' });
	} catch (error) {
		// A pass that outlives the hourly schedule still holds the lock. That is
		// the previous run working, not a failure of this one.
		if ((error.stderr ?? '').includes('Another indexer is already running')) {
			console.log('indexer: previous run still in progress, skipping this tick.');
			return ``;
		}
		console.error('indexer failed:', error);
	} finally {
		module.eventEmitter.emit('indexer:index:updated');
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
