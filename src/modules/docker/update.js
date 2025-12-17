const fs = require('fs');
const path = require('path');
const stream = require('stream');
const streamPipeline = require('util').promisify(stream.pipeline);
const dockerCompose = require('docker-compose');
const docker = require('../../utils/docker_client');
const dockerPullProgressParser = require('../../utils/docker_pull_progress_parser');
const DataService = require('../../database/data_service');

const updateApp = async (job, module) => {
	const config = job.data.config;
	const existingApp = await DataService.getApplication(config?.name);
	if (!existingApp) {
		throw new Error(`App not found.`);
	}

	const container = module.getState('containers')?.find((container) => { return container.name === config.name });
	if (!container) {
		throw new Error(`Container for app '${config.name}' not found.`);
	}
	
	const composeProject = container.labels.comDockerComposeProject;
	const composeProjectDir = container.labels.comDockerComposeProjectWorkingDir;
	const composeProjectContainers = module.getState('containers')?.filter((container) => {
		return container.labels && container.labels['comDockerComposeProject'] === composeProject;
	});
	await module.updateJobProgress(job, `${existingApp.title} update starting...`);
	const template = module.getState('templates')?.find((template) => { return template.name === config.name; });
	if (template) {
		try {
			const response = await fetch(`${template.repository.url}${template.repository.stackfile}`);
			if (response.ok) {
				const stack = await response.text();
				await module.updateJobProgress(job, `Writing ${template.title} project template...`);
				await fs.promises.writeFile(path.join(composeProjectDir, 'docker-compose.yml'), stack, 'utf-8');
				const icon = template.logo.split('/').pop();
				const responseIcon = await fetch(template.logo);
				if (responseIcon.ok) {
					await streamPipeline(responseIcon.body, fs.createWriteStream(path.join(module.appIconsDir, icon)));
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
		callback: (chunk) => {
			module.updateJobProgress(job, chunk.toString());
		}
	});

	await module.updateJobProgress(job, `Cleaning up...`);
	await docker.pruneImages();
	let updates = module.getState('updates')?.filter((update) => {
		return !composeProjectContainers.some((container) => { return container.id === update.containerId; });
	});
	module.setState('updates', updates);
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

module.exports = {
	name: 'update',
	onConnection,
	jobs: {
		'app:update': updateApp
	}
};
