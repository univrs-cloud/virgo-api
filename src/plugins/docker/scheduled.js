
module.exports = {
	register(plugin) {
		// Schedule updates checker to run daily at midnight
		plugin.addJobSchedule(
			'updates:check',
			{ pattern: '0 0 0 * * *' }
		);
		
		// Schedule templates fetcher to run every hour at minute 1
		plugin.addJobSchedule(
			'templates:fetch',
			{ pattern: '0 1 * * * *' }
		);
	},
	jobs: {
		'updates:check': async (job, plugin) => {
			return await plugin.checkForUpdates();
		},
		'templates:fetch': async (job, plugin) => {
			return await plugin.fetchTemplates();
		}
	}
};

