const changeCase = require('change-case');
const DataService = require('../../database/data_service');

const updateBookmark = async (job, module) => {
	const config = job.data.config;
	const existingBookmark = await DataService.getBookmark(config?.name);
	if (!existingBookmark) {
		throw new Error(`Bookmark not found.`);
	}

	await module.updateJobProgress(job, `${existingBookmark.title} bookmark is updating...`);
	const bookmark = {
		name: changeCase.kebabCase(config.title),
		category: config.category,
		icon: existingBookmark.icon,
		title: config.title,
		url: config.url,
		order: existingBookmark.order
	};
	await DataService.setBookmark(bookmark);
	module.eventEmitter.emit('configured:updated');
	return `${existingBookmark.title} bookmark updated.`;
};

module.exports = {
	name: 'update',
	onConnection(socket, module) {
		socket.on('bookmark:update', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}
			
			await module.addJob('bookmark:update', { config, username: socket.username });
		});
	},
	jobs: {
		'bookmark:update': updateBookmark
	}
};
