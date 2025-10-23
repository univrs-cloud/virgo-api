const fs = require('fs');
const path = require('path');
const { execa } = require('execa');
const stream = require('stream');
const streamPipeline = require('util').promisify(stream.pipeline);
const dockerCompose = require('docker-compose');
const DataService = require('../../database/data_service');

const installApp = async (job, plugin) => {
	const config = job.data.config;
	const template = plugin.getState('templates')?.find((template) => { return template.id === config.id; });
	if (!template) {
		throw new Error(`App template not found.`);
	}

	if (template.type !== 3) { // only docker compose is supported
		throw new Error(`Installing this app type is not supported.`);
	}

	const existingApp = await DataService.getApplication(template?.name);
	if (existingApp) {
		throw new Error(`App already installed.`);
	}

	await plugin.updateJobProgress(job, `${template.title} installation starting...`);
	const dataset = `${plugin.appsDataset}/${template.name}`;
	const appDir = path.join(plugin.appsDir, template.name);
	try {
		await fs.promises.access(appDir);
		await plugin.updateJobProgress(job, `Storage space ${dataset} for ${template.title} already exists. Skipping creation.`);
	} catch (error) {
		if (error.code === 'ENOENT') {
			await plugin.updateJobProgress(job, `Creating storage space ${dataset} for ${template.title}...`);
			try {
				await execa('zfs', ['create', dataset]); // Only create dataset if not exists
				await plugin.updateJobProgress(job, `Storage space ${dataset} created for ${template.title}.`);
			} catch (error) {
				throw new Error(`Could not create storage space ${dataset} for ${template.title}.`);
			}
		}
	}
	await plugin.updateJobProgress(job, `Downloading ${template.title} project template...`);
	const response = await fetch(plugin.getRawGitHubUrl(template.repository.url, template.repository.stackfile));
	if (!response.ok) {
		throw new Error(`Failed to download app template: ${response.status} ${response.statusText}`);
	}
	
	const stack = await response.text();
	let env = Object.entries(config.env).map(([key, value]) => `${key}='${value}'`).join('\n');
	const composeProjectDir = path.join(plugin.composeDir, template.name);
	await plugin.updateJobProgress(job, `Making ${template.title} project directory...`);
	await fs.promises.mkdir(composeProjectDir, { recursive: true });
	await plugin.updateJobProgress(job, `Writing ${template.title} project template...`);
	await fs.promises.writeFile(path.join(composeProjectDir, 'docker-compose.yml'), stack, 'utf-8');
	await plugin.updateJobProgress(job, `Writing ${template.title} project configuration...`);
	await fs.promises.writeFile(path.join(composeProjectDir, '.env'), env, 'utf-8');
	await plugin.updateJobProgress(job, `Installing ${template.title}...`);
	await dockerCompose.upAll({
		cwd: composeProjectDir,
		callback: async (chunk) => {
			await plugin.updateJobProgress(job, chunk.toString());
		}
	});

	const icon = template.logo.split('/').pop();
	const responseIcon = await fetch(template.logo);
	if (responseIcon.ok) {
		await streamPipeline(responseIcon.body, fs.createWriteStream(path.join(plugin.appIconsDir, icon)));
	}
	const app = {
		name: template.name,
		canBeRemoved: true,
		category: template.categories.find((_, index) => { return index === 0; }),
		icon: icon,
		title: template.title
	};
	await plugin.updateJobProgress(job, `Updating apps registry...`);
	await DataService.setApplication(app);
	plugin.getInternalEmitter().emit('configured:updated');
	return `${template.title} installed.`;
};

module.exports = {
	name: 'install',
	onConnection(socket, plugin) {
		socket.on('app:install', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await plugin.addJob('app:install', { config, username: socket.username });
		});
	},
	jobs: {
		'app:install': installApp
	}
};
