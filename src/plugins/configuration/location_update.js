const DataService = require('../../database/data_service');

const updateLocation = async (job, plugin) => {
	let config = job.data.config;
	await plugin.updateJobProgress(job, `Saving location...`);	
	await DataService.setConfiguration('location', config);
	plugin.getInternalEmitter().emit('configuration:updated');
	await plugin.broadcastConfiguration();
	plugin.getInternalEmitter().emit('configuration:location:updated');
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
