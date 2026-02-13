const fs = require('fs');
const path = require('path');
const stream = require('stream');
const streamPipeline = require('util').promisify(stream.pipeline);
const changeCase = require('change-case');
const DataService = require('../../database/data_service');

const createBookmark = async (job, module) => {
	const { config } = job.data;
	await module.updateJobProgress(job, `${config?.title} bookmark is creating...`);
	let icon = '';
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
		name: config.name || changeCase.kebabCase(config.title),
		category: config.category,
		icon,
		title: config.title,
		url: config.url,
		traefik: config.traefik
	};
	await DataService.setBookmark(bookmark);
	module.eventEmitter.emit('configured:updated');
	return `${config.title} bookmark created.`;
};

const onConnection = (socket, module) => {
	socket.on('bookmark:create', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		
		await module.addJob('bookmark:create', { config, username: socket.username });
	});
};

module.exports = {
	name: 'create',
	onConnection,
	jobs: {
		'bookmark:create': createBookmark
	}
};
