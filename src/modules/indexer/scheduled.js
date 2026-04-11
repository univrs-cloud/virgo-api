const { execa } = require('execa');

const index = async () => {
	try {
		await execa('virgo', ['index'], { stdio: 'inherit' });
	} catch (error) {
		console.error('virgo index failed:', error);
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
