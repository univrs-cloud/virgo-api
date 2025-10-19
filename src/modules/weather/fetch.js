module.exports = {
	name: 'fetch',
	register(plugin) {
		plugin.addJobSchedule(
			'weather:fetch',
			{ pattern: '0 1 * * * *' }
		);
	},
	jobs: {
		'weather:fetch': async (job, plugin) => {
			plugin.fetchRetries = 3;
			plugin.fetchWeather();
			return '';
		}
	}
};
