const fs = require('fs');

module.exports = {
	onConnection(socket, plugin) {
		socket.on('configuration:location:update', async (config) => {
			await plugin.addJob('location:update', { config, username: socket.username });
		});
	},
	jobs: {
		'location:update': async (job, plugin) => {
			let config = job.data.config;
			await plugin.updateJobProgress(job, `Saving location...`);
			
			let configuration = plugin.getState('configuration');
			configuration.location = config;
			fs.writeFileSync(plugin.configurationFile, JSON.stringify(configuration, null, 2), 'utf8', { flag: 'w' });
			plugin.setState('configuration', configuration);
			
			return `Location saved.`;
		}
	}
};
