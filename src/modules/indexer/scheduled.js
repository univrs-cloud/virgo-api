const { execa } = require('execa');

const index = async () => {
	try {
		await execa('virgo', ['index'], { stdout: 'ignore' });
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
		'indexer:index': async () => {
			return await index();
		}
	}
};
