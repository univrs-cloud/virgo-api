const DataService = require('../../database/data_service');

const updateBookmarkOrder = async (job, plugin) => {
	const config = job.data.config;
	const existingBookmark = await DataService.getBookmark(config?.name);
	if (!existingBookmark) {
		throw new Error(`Bookmark not found.`);
	}

	await plugin.updateJobProgress(job, `${existingBookmark.title} bookmark order is updating...`);
	await DataService.updateBookmarkOrder(config.name, config.order);
	await plugin.loadConfigured();
	return `${existingBookmark.title} bookmark order updated.`;
};

module.exports = {
	name: 'bookmark_order',
	onConnection(socket, plugin) {
		socket.on('bookmark:updateOrder', async (config) => {
			await plugin.handleDockerAction(socket, 'bookmark:updateOrder', config);
		});
	},
	jobs: {
		'bookmark:updateOrder': updateBookmarkOrder
	}
};
