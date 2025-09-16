const fs = require('fs');
const changeCase = require('change-case');

const updateBookmark = async (job, plugin) => {
	let config = job.data.config;
	const existingBookmark = plugin.getState('configured')?.configuration.find((entity) => { return entity.type === 'bookmark' && entity.name === config?.name; });
	if (!existingBookmark) {
		throw new Error(`Bookmark not found.`);
	}

	await plugin.updateJobProgress(job, `${existingBookmark.title} bookmark is updating...`);
	let configuration = [...plugin.getState('configured')?.configuration ?? []]; // need to clone so we don't modify the reference
	configuration = configuration.filter((entity) => { return entity.name !== config.name; });
	configuration.push({
		name: changeCase.kebabCase(config.title),
		type: 'bookmark',
		canBeRemoved: true,
		category: config.category,
		icon: '',
		title: config.title,
		url: config.url
	});
	fs.writeFileSync(plugin.dataFile, JSON.stringify({ configuration }, null, 2), 'utf-8', { flag: 'w' });
	return `${existingBookmark.title} bookmark updated.`;
};

module.exports = {
	name: 'bookmark_update',
	onConnection(socket, plugin) {
		socket.on('bookmark:update', async (config) => {
			await plugin.handleDockerAction(socket, 'bookmark:update', config);
		});
	},
	jobs: {
		'bookmark:update': updateBookmark
	}
};
