import { createWriteStream, promises as fs } from 'fs';
import path from 'path';
import stream from 'stream';
import { promisify } from 'util';
import * as changeCase from 'change-case';
import DataService from '../../database/data_service.js';

const streamPipeline = promisify(stream.pipeline);

const createShortcut = async (job, module) => {
	const { config } = job.data;
	await module.updateJobProgress(job, `${config?.title} shortcut is creating...`);
	let icon = '';
	if (config?.icon && config.icon !== '') {
		const iconFilename = config.icon.split('/').pop();
		const responseIcon = await fetch(config.icon);
		if (responseIcon.ok) {
			await fs.mkdir(module.shortcutIconsDir, { recursive: true });
			await streamPipeline(responseIcon.body, createWriteStream(path.join(module.shortcutIconsDir, iconFilename)));
			icon = iconFilename;
		}
	}
	const shortcut = {
		name: config.name || changeCase.kebabCase(config.title),
		category: config.category,
		icon,
		title: config.title,
		url: config.url,
		traefik: config.traefik
	};
	await DataService.setShortcut(shortcut);
	module.eventEmitter.emit('configured:updated');
	return `${config.title} shortcut created.`;
};

const onConnection = (socket, module) => {
	socket.on('shortcut:create', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		
		await module.addJob('shortcut:create', { config, username: socket.username });
	});
};

export default {
	name: 'create',
	onConnection,
	jobs: {
		'shortcut:create': createShortcut
	}
};
