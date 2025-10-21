
module.exports = {
	name: 'scheduled',
	register(plugin) {
		// Schedule templates fetcher to run every hour at minute 1
		plugin.addJobSchedule(
			'templates:fetch',
			{ pattern: '0 1 * * * *' }
		);
	},
	jobs: {
		'templates:fetch': async (job, plugin) => {
			plugin.getInternalEmitter().emit('templates:fetch');
			return '';
		}
	}
};
