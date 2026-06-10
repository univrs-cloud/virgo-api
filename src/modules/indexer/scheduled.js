import { execa } from 'execa';

const index = async (job, module) => {
	try {
		await execa('virgo', ['indexer', 'index'], { stdout: 'ignore' });
	} catch (error) {
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
