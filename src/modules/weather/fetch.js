module.exports = {
	name: 'fetch',
	register(module) {
		module.addJobSchedule(
			'weather:fetch',
			{ pattern: '0 1 * * * *' }
		);
	},
	jobs: {
		'weather:fetch': async (job, module) => {
			module.fetchRetries = 3;
			module.fetchWeather();
			return '';
		}
	}
};
