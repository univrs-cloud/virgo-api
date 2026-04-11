const { execa } = require('execa');

const index = async (job, module) => {
	try {
		await execa('virgo', ['index'], { stdout: 'ignore' });
		module.eventEmitter.emit('indexer:index:updated');
	} catch (error) {
		console.error('indexer failed:', error);
	}
	return ``;
};

const register = (module) => {
	module.addJobSchedule(
		'indexer:index',
		{ pattern: '0 10 * * * *' }
	);
};

module.exports = {
	name: 'scheduled',
	register,
	jobs: {
		'indexer:index': index
	}
};
