import { createWriteStream, promises as fs } from 'fs';
import path from 'path';
import stream from 'stream';
import { promisify } from 'util';
import dockerCompose from 'docker-compose';
import docker from '../../utils/docker_client.js';
import dockerPullProgressParser from '../../utils/docker_pull_progress_parser.js';
import DataService from '../../database/data_service.js';

const streamPipeline = promisify(stream.pipeline);
const updateApp = async (job, module) => {
	const { config } = job.data;
	const existingApp = await DataService.getApplication(config?.name);
	if (!existingApp) {
		throw new Error(`App not found.`);
	}

	const containers = await module.findContainersByAppName(config.name);
	if (containers.length === 0) {
		throw new Error(`Containers for app '${config.name}' not found.`);
	}
	
	const container = containers[0];
	const composeProject = container.labels?.comDockerComposeProject;
	const composeProjectDir = container.labels?.comDockerComposeProjectWorkingDir || path.join(module.composeDir, composeProject);
	await module.updateJobProgress(job, `${existingApp.title} update starting...`);
	const template = module.toArray(module.getState('templates')).find((template) => { return template.name === config.name; });
	if (template) {
		try {
			const response = await fetch(`${template.repository.url}${template.repository.stackfile}`);
			if (response.ok) {
				const stack = await response.text();
				await module.updateJobProgress(job, `Writing ${template.title} project template...`);
				await fs.writeFile(path.join(composeProjectDir, 'docker-compose.yml'), stack, 'utf-8');
				const icon = template.logo.split('/').pop();
				const responseIcon = await fetch(template.logo);
				if (responseIcon.ok) {
					await streamPipeline(responseIcon.body, createWriteStream(path.join(module.appIconsDir, icon)));
					const updatedApp = { ...existingApp, icon: icon };
					await DataService.setApplication(updatedApp);
					module.eventEmitter.emit('configured:updated');
				}
			}
		} catch (error) {}
	}

	await module.updateJobProgress(job, `Downloading ${existingApp.title}...`);
	const parsePullProgress = dockerPullProgressParser();
	await dockerCompose.pullAll({
		cwd: composeProjectDir,
		composeOptions: [['--progress', 'json']],
		callback: (chunk) => {
			const progress = parsePullProgress(chunk);
			if (progress) {
				module.updateJobProgress(job, `Downloading ${existingApp.title}...`, progress);
			}
		}
	});
	await module.updateJobProgress(job, `Updating ${existingApp.title}...`);
	await dockerCompose.upAll({
		cwd: composeProjectDir,
		commandOptions: ['--remove-orphans'],
		callback: (chunk) => {
			module.updateJobProgress(job, chunk.toString());
		}
	});

	await module.updateJobProgress(job, `Cleaning up...`);
	await docker.pruneImages();
	let updates = module.toArray(module.getState('updates')).filter((update) => {
		return !containers.some((container) => { return container.id === update.containerId; });
	});
	module.setState('updates', updates);
	module.eventEmitter.emit('app:updates:updated', module.getState('updates'));
	module.nsp.emit('app:updates', module.getState('updates'));
	return `${existingApp.title} updated.`;
};

const onConnection = (socket, module) => {
	socket.on('app:update', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('app:update', { config, username: socket.username });
	});
};

export default {
	name: 'update',
	onConnection,
	jobs: {
		'app:update': updateApp
	}
};
