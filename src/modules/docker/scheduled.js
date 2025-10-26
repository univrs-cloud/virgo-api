
module.exports = {
	name: 'scheduled',
	register(module) {
		// Schedule templates fetcher to run every hour at minute 1
		module.addJobSchedule(
			'templates:fetch',
			{ pattern: '0 1 * * * *' }
		);
	},
	jobs: {
		'templates:fetch': async (job, module) => {
			module.getInternalEmitter().emit('templates:fetch');
			return '';
		}
	}
};
