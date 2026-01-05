const DataService = require('../../database/data_service');

const updateLocation = async (job, module) => {
	const { config } = job.data;
	await module.updateJobProgress(job, `Saving location...`);	
	await DataService.setConfiguration('location', config);
	module.eventEmitter.emit('configuration:updated');
	module.eventEmitter.emit('configuration:location:updated');
	return `Location saved.`;
};

const onConnection = (socket, module) => {
	socket.on('configuration:location:update', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		
		await module.addJob('location:update', { config, username: socket.username });
	});
};

module.exports = {
	onConnection,
	jobs: {
		'location:update': updateLocation
	}
};
