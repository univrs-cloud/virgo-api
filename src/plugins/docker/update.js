const fs = require('fs');
const path = require('path');
const stream = require('stream');
const streamPipeline = require('util').promisify(stream.pipeline);
const dockerCompose = require('docker-compose');
const dockerode = require('dockerode');

const docker = new dockerode();

module.exports = {
	onConnection(socket, plugin) {
		socket.on('app:update', async (config) => {
			await plugin.handleDockerAction(socket, 'app:update', config);
		});
	},
	jobs: {
		'app:update': async (job, plugin) => {
			let config = job.data.config;
			const existingApp = plugin.getState('configured')?.configuration.find((entity) => { return entity.type === 'app' && entity.name === config?.name; });
			if (!existingApp) {
				throw new Error(`App not found.`);
			}
		
			let template = plugin.getState('templates')?.find((template) => { return template.name === config.name; });
			const container = plugin.getState('containers')?.find((container) => { return container.name === config.name });
			const composeProject = container.labels.comDockerComposeProject;
			const composeProjectDir = container.labels.comDockerComposeProjectWorkingDir;
			const composeProjectContainers = plugin.getState('containers')?.filter((container) => {
				return container.labels && container.labels['comDockerComposeProject'] === composeProject;
			});
			await plugin.updateJobProgress(job, `${existingApp.title} update starting...`);
			if (template) {
				try {
					const response = await fetch(plugin.getRawGitHubUrl(template.repository.url, template.repository.stackfile));
					const stack = await response.text();
					await plugin.updateJobProgress(job, `Writing ${template.title} project template...`);
					fs.writeFileSync(path.join(composeProjectDir, 'docker-compose.yml'), stack, 'utf-8', { flag: 'w' });
					const icon = template.logo.split('/').pop();
					const responseIcon = await fetch(template.logo);
					await streamPipeline(responseIcon.body, fs.createWriteStream(`/var/www/virgo-ui/app/dist/assets/img/apps/${icon}`));
					let configuration = [...plugin.getState('configured')?.configuration ?? []]; // need to clone so we don't modify the reference
					configuration = configuration.map((entity) => {
						if (entity.type === 'app' && entity.name === config.name) {
							entity.icon = icon;
						}
						return entity;
					});
					fs.writeFileSync(plugin.dataFile, JSON.stringify({ configuration }, null, 2), 'utf-8', { flag: 'w' });
				} catch (error) {}
			}
		
			await plugin.updateJobProgress(job, `Downloading ${existingApp.title} updates...`);
			await dockerCompose.pullAll({
				cwd: composeProjectDir,
				callback: async (chunk) => {
					await plugin.updateJobProgress(job, chunk.toString());
				}
			});
			await plugin.updateJobProgress(job, `Installing ${existingApp.title} updates...`);
			await dockerCompose.upAll({
				cwd: composeProjectDir,
				callback: async (chunk) => {
					await plugin.updateJobProgress(job, chunk.toString());
				}
			});
			await plugin.updateJobProgress(job, `Cleaning up...`);
			await docker.pruneImages();
			let updates = plugin.getState('updates')?.filter((update) => {
				return !composeProjectContainers.some((container) => { return container.id === update.containerId; });
			});
			plugin.setState('updates', updates);
			plugin.getNsp().emit('app:updates', plugin.getState('updates'));
			return `${existingApp.title} updated.`;
		}
	}
};
