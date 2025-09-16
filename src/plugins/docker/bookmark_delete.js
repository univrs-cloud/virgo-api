const fs = require('fs');

const deleteBookmark = async (job, plugin) => {
	let config = job.data.config;
	const existingBookmark = plugin.getState('configured')?.configuration.find((entity) => { return entity.type === 'bookmark' && entity.name === config?.name; });
	if (!existingBookmark) {
		throw new Error(`Bookmark not found.`);
	}

	await plugin.updateJobProgress(job, `${existingBookmark.title} bookmark is deleting...`);
	let configuration = [...plugin.getState('configured')?.configuration ?? []]; // need to clone so we don't modify the reference
	configuration = configuration.filter((entity) => { return entity.name !== config.name });
	fs.writeFileSync(plugin.dataFile, JSON.stringify({ configuration }, null, 2), 'utf-8', { flag: 'w' });
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
