const fs = require('fs');
const changeCase = require('change-case');

const createBookmark = async (job, plugin) => {
	let config = job.data.config;
	await plugin.updateJobProgress(job, `${config?.title} bookmark is creating...`);
	let configuration = [...plugin.getState('configured')?.configuration ?? []]; // need to clone so we don't modify the reference
	configuration = configuration.filter((entity) => { return entity.url !== config?.url });
	configuration.push({
		name: changeCase.kebabCase(config.title),
		type: 'bookmark',
		canBeRemoved: true,
		category: config.category,
		icon: '',
		title: config.title,
		url: config.url
	});
	await fs.promises.writeFile(plugin.dataFile, JSON.stringify({ configuration }, null, 2), 'utf-8');
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
