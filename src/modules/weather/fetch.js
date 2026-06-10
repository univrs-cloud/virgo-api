const register = (module) => {
	module.addJobSchedule(
		'weather:fetch',
		{ pattern: '0 1 * * * *' }
	);
};

export default {
	name: 'fetch',
	register,
	jobs: {
		'weather:fetch': async (job, module) => {
			module.fetchRetries = 3;
			await module.fetchWeather();
			return ``;
		}
	}
};
