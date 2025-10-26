module.exports = {
	name: 'scheduled',
	register(module) {
		module.checkForUpdates();
		
		// Schedule updates checker to run daily at midnight
		module.addJobSchedule(
			'updates:check',
			{ pattern: '0 0 0 * * *' }
		);
	},
	jobs: {
		'updates:check': async (job, module) => {
			module.checkForUpdates();
			return '';
		}
	}
};
