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
		url: config.url
	};
	await DataService.setBookmark(bookmark);
	plugin.getInternalEmitter().emit('configured:updated');
	return `${config.title} bookmark created.`;
};

module.exports = {
	name: 'create',
	onConnection(socket, plugin) {
		socket.on('bookmark:create', async (config) => {
			await plugin.addJob('bookmark:create', { config, username: socket.username });
		});
	},
	jobs: {
		'bookmark:create': createBookmark
	}
};
