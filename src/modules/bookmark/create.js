import fs from 'fs';
import path from 'path';
import stream from 'stream';
import { promisify } from 'util';
import * as changeCase from 'change-case';
import DataService from '../../database/data_service.js';

const streamPipeline = promisify(stream.pipeline);

const createBookmark = async (job, module) => {
	const { config } = job.data;
	await module.updateJobProgress(job, `${config?.title} bookmark is creating...`);
	let icon = '';
	if (config?.icon && config.icon !== '') {
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

export default {
	name: 'create',
	onConnection,
	jobs: {
		'bookmark:create': createBookmark
	}
};
