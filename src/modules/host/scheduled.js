module.exports = {
	name: 'scheduled',
	register(plugin) {
		// Schedule updates checker to run daily at midnight
		plugin.addJobSchedule(
			'updates:check',
			{ pattern: '0 0 0 * * *' }
		);
	},
	jobs: {
		'updates:check': async (job, plugin) => {
			plugin.checkForUpdates();
			return '';
		}
	}
};
