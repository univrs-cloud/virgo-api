module.exports = {
	name: 'scheduled',
	register(plugin) {
		// Schedule updates checker to run daily at midnight
		plugin.addJobSchedule(
			'updates:check',
			{ pattern: '0 0 0 * * *' }
		);
		
		// Schedule UPS checker to run every minute (if I2C is available)
		if (plugin.i2c !== false) {
			plugin.addJobSchedule(
				'ups:check',
				{ pattern: '0 * * * * *' }
			);
		}
	},
	jobs: {
		'updates:check': async (job, plugin) => {
			plugin.checkForUpdates();
			return '';
		},
		'ups:check': async (job, plugin) => {
			plugin.checkUps();
			return  '';
		}
	}
};
