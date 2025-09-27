const fs = require('fs');
const path = require('path');
const stream = require('stream');
const streamPipeline = require('util').promisify(stream.pipeline);
const dockerCompose = require('docker-compose');
const DataService = require('../../database/data_service');

const installApp = async (job, plugin) => {
	let config = job.data.config;
	let template = plugin.getState('templates')?.find((template) => { return template.id === config.id; });
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
		await streamPipeline(responseIcon.body, fs.createWriteStream(`/var/www/virgo-ui/app/dist/assets/img/apps/${icon}`));
	}
	const app = {
		name: template.name,
		canBeRemoved: true,
		category: template.categories.find((_, index) => { return index === 0; }),
		icon: icon,
		title: template.title,
		order: await DataService.getNextApplicationOrder()
	};
	await plugin.updateJobProgress(job, `Updating apps configuration...`);
	await DataService.setApplication(app);
	await plugin.loadConfigured();
	return `${template.title} installed.`;
};

module.exports = {
	name: 'install',
	onConnection(socket, plugin) {
		socket.on('app:install', async (config) => {
			await plugin.handleDockerAction(socket, 'app:install', config);
		});
	},
	jobs: {
		'app:install': installApp
	}
};
