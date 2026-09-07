import { createWriteStream, promises as fs } from 'fs';
import path from 'path';
import stream from 'stream';
import { promisify } from 'util';
import * as changeCase from 'change-case';
import DataService from '../../database/data_service.js';

const streamPipeline = promisify(stream.pipeline);

const updateShortcut = async (job, module) => {
	const { config } = job.data;
	const existingShortcut = await DataService.getShortcut(config?.name);
	if (!existingShortcut) {
		throw new Error(`Shortcut not found.`);
	}

	await module.updateJobProgress(job, `${existingShortcut.title} shortcut is updating...`);
	let icon = existingShortcut.icon;
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
		id: existingShortcut.id,
		name: config.name || changeCase.kebabCase(config.title),
		category: config.category,
		icon,
		title: config.title,
		url: config.url,
		traefik: config.traefik,
		order: existingShortcut.order
	};
	await DataService.setShortcut(shortcut);
	module.eventEmitter.emit('configured:updated');
	return `${existingShortcut.title} shortcut updated.`;
};

const onConnection = (socket, module) => {
	socket.on('shortcut:update', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		
		await module.addJob('shortcut:update', { config, username: socket.username });
	});
};

export default {
	name: 'update',
	onConnection,
	jobs: {
		'shortcut:update': updateShortcut
	}
};
