import { createWriteStream, promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import stream from 'stream';
import { promisify } from 'util';
import * as changeCase from 'change-case';
import DataService from '../../database/data_service.js';

const streamPipeline = promisify(stream.pipeline);

const assertSubdomainFree = async (subdomain) => {
	const peers = ((await DataService.getConfiguration()).peers || []);
	const nodeNames = [os.hostname(), ...peers.map((peer) => { return peer.name; })].filter(Boolean).map((name) => { return name.toLowerCase(); });
	if (subdomain && nodeNames.includes(String(subdomain).toLowerCase())) {
		throw new Error(`'${subdomain}' is a node's name, choose another subdomain.`);
	}
};

const createShortcut = async (job, module) => {
	const { config } = job.data;
	await assertSubdomainFree(config?.traefik?.subdomain);
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

export default {
	name: 'create',
	commands: {
		'shortcut:create': { job: 'shortcut:create' }
	},
	jobs: {
		'shortcut:create': createShortcut
	}
};
