const changeCase = require('change-case');
const DataService = require('../../database/data_service');

const updateBookmark = async (job, plugin) => {
	let config = job.data.config;
	const existingBookmark = await DataService.getBookmark(config?.name);
	if (!existingBookmark) {
		throw new Error(`Bookmark not found.`);
	}

	await plugin.updateJobProgress(job, `${existingBookmark.title} bookmark is updating...`);
	const bookmark = {
		name: changeCase.kebabCase(config.title),
		category: config.category,
		icon: existingBookmark.icon,
		title: config.title,
		url: config.url,
		order: existingBookmark.order
	};
	await DataService.setBookmark(bookmark);
	plugin.getInternalEmitter().emit('configured:updated');
	return `${existingBookmark.title} bookmark updated.`;
};

module.exports = {
	name: 'update',
	onConnection(socket, plugin) {
		socket.on('bookmark:update', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}
			
			await plugin.addJob('bookmark:update', { config, username: socket.username });
		});
	},
	jobs: {
		'bookmark:update': updateBookmark
	}
};
