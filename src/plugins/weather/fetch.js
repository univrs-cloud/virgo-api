let fetchRetries = 3;

module.exports = {
	onConnection(socket, plugin) {
	},
	jobs: {
		'weather:fetch': async (job, plugin) => {
			plugin.fetchRetries = 3;
			return await plugin.fetchWeather();
		}
	}
};
