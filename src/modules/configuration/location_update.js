const DataService = require('../../database/data_service');

const updateLocation = async (job, module) => {
	const config = job.data.config;
	await module.updateJobProgress(job, `Saving location...`);	
	await DataService.setConfiguration('location', config);
	module.getInternalEmitter().emit('configuration:updated');
	module.getInternalEmitter().emit('configuration:location:updated');
	return `Location saved.`;
};

module.exports = {
	onConnection(socket, module) {
		socket.on('configuration:location:update', async (config) => {
			await module.addJob('location:update', { config, username: socket.username });
		});
	},
	jobs: {
		'location:update': updateLocation
	}
};
