const fs = require('fs');

const updateLocation = async (job, plugin) => {
	let config = job.data.config;
	await plugin.updateJobProgress(job, `Saving location...`);
	
	let configuration = plugin.getState('configuration');
	configuration.location = config;
	await fs.promises.writeFile(plugin.configurationFile, JSON.stringify(configuration, null, 2), 'utf8');
	plugin.setState('configuration', configuration);
	
	return `Location saved.`;
};

module.exports = {
	onConnection(socket, plugin) {
		socket.on('configuration:location:update', async (config) => {
			await plugin.addJob('location:update', { config, username: socket.username });
		});
	},
	jobs: {
		'location:update': updateLocation
	}
};
