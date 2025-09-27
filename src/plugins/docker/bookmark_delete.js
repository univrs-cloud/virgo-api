const DataService = require('../../database/data_service');

const deleteBookmark = async (job, plugin) => {
	const config = job.data.config;
	const existingBookmark = await DataService.getBookmark(config?.name);
	if (!existingBookmark) {
		throw new Error(`Bookmark not found.`);
	}
	
	await plugin.updateJobProgress(job, `${existingBookmark.title} bookmark is deleting...`);
	await DataService.deleteBookmark(config.name);
	await plugin.loadConfigured();
	return `${existingBookmark.title} bookmark deleted.`;
};

module.exports = {
	name: 'bookmark_delete',
	onConnection(socket, plugin) {
		socket.on('bookmark:delete', async (config) => {
			await plugin.handleDockerAction(socket, 'bookmark:delete', config);
		});
	},
	jobs: {
		'bookmark:delete': deleteBookmark
	}
};
