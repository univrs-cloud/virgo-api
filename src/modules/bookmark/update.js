const fs = require('fs');
const path = require('path');
const stream = require('stream');
const streamPipeline = require('util').promisify(stream.pipeline);
const changeCase = require('change-case');
const DataService = require('../../database/data_service');

const updateBookmark = async (job, module) => {
	const { config } = job.data;
	const existingBookmark = await DataService.getBookmark(config?.name);
	if (!existingBookmark) {
		throw new Error(`Bookmark not found.`);
	}

	await module.updateJobProgress(job, `${existingBookmark.title} bookmark is updating...`);
	let icon = existingBookmark.icon;
	if (config?.icon) {
		const iconFilename = config.icon.split('/').pop();
		const responseIcon = await fetch(config.icon);
		if (responseIcon.ok) {
			await fs.promises.mkdir(module.bookmarkIconsDir, { recursive: true });
			await streamPipeline(responseIcon.body, fs.createWriteStream(path.join(module.bookmarkIconsDir, iconFilename)));
			icon = iconFilename;
		}
	}
	const bookmark = {
		id: existingBookmark.id,
		name: config.name || changeCase.kebabCase(config.title),
		category: config.category,
		icon,
		title: config.title,
		url: config.url,
		traefik: config.traefik,
		order: existingBookmark.order
	};
	await DataService.setBookmark(bookmark);
	module.eventEmitter.emit('configured:updated');
	return `${existingBookmark.title} bookmark updated.`;
};

const onConnection = (socket, module) => {
	socket.on('bookmark:update', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		
		await module.addJob('bookmark:update', { config, username: socket.username });
	});
};

module.exports = {
	name: 'update',
	onConnection,
	jobs: {
		'bookmark:update': updateBookmark
	}
};
