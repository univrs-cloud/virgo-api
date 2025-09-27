const DataService = require('../../database/data_service');

const updateAppOrder = async (job, plugin) => {
	const config = job.data.config;
	const existingApp = await DataService.getApplication(config?.name);
	if (!existingApp) {
		throw new Error(`App not found.`);
	}

	await plugin.updateJobProgress(job, `${existingApp.title} order updating...`);
	await DataService.updateApplicationOrder(config.name, config.order);
	await plugin.loadConfigured();
	return `${existingApp.title} order updated.`;
};

module.exports = {
	name: 'app_order',
	onConnection(socket, plugin) {
		socket.on('app:updateOrder', async (config) => {
			await plugin.handleDockerAction(socket, 'app:updateOrder', config);
		});
	},
	jobs: {
		'app:updateOrder': updateAppOrder
	}
};
