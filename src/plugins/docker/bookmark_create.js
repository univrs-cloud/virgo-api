const changeCase = require('change-case');
const DataService = require('../../database/data_service');

const createBookmark = async (job, plugin) => {
	const config = job.data.config;
	await plugin.updateJobProgress(job, `${config?.title} bookmark is creating...`);
	const bookmark = {
		name: changeCase.kebabCase(config.title),
		category: config.category,
		icon: '',
		title: config.title,
		url: config.url,
		order: await DataService.getNextBookmarkOrder()
	};
	await DataService.setBookmark(bookmark);
	await plugin.loadConfigured();
	return `${config.title} bookmark created.`;
};

module.exports = {
	name: 'bookmark_create',
	onConnection(socket, plugin) {
		socket.on('bookmark:create', async (config) => {
			await plugin.handleDockerAction(socket, 'bookmark:create', config);
		});
	},
	jobs: {
		'bookmark:create': createBookmark
	}
};
