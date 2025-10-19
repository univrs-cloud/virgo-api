const DataService = require('../../database/data_service');

const deleteBookmark = async (job, plugin) => {
	const config = job.data.config;
	const existingBookmark = await DataService.getBookmark(config?.name);
	if (!existingBookmark) {
		throw new Error(`Bookmark not found.`);
	}
	
	await plugin.updateJobProgress(job, `${existingBookmark.title} bookmark is deleting...`);
	await DataService.deleteBookmark(config.name);
	plugin.getInternalEmitter().emit('configured:updated');
	return `${existingBookmark.title} bookmark deleted.`;
};

module.exports = {
	name: 'delete',
	onConnection(socket, plugin) {
		socket.on('bookmark:delete', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}
			
			await plugin.addJob('bookmark:delete', { config, username: socket.username });
		});
	},
	jobs: {
		'bookmark:delete': deleteBookmark
	}
};
