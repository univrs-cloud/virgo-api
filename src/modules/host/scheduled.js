const register = (module) => {
	module.checkForUpdates();
	
	// Schedule updates checker to run daily at midnight
	module.addJobSchedule(
		'updates:check',
		{ pattern: '0 0 0 * * *' }
	);
};

module.exports = {
	name: 'scheduled',
	register,
	jobs: {
		'updates:check': async (job, module) => {
			module.checkForUpdates();
			return '';
		}
	}
};
