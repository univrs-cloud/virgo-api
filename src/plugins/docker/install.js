const fs = require('fs');
const path = require('path');
const stream = require('stream');
const streamPipeline = require('util').promisify(stream.pipeline);
const dockerCompose = require('docker-compose');

const installApp = async (job, plugin) => {
	let config = job.data.config;
	let template = plugin.getState('templates')?.find((template) => { return template.id === config.id; });
	if (!template) {
		throw new Error(`App template not found.`);
	}

	if (template.type !== 3) { // only docker compose is supported
		throw new Error(`Installing this app type is not supported.`);
	}

	const existingApp = plugin.getState('configured')?.configuration.find((entity) => { return entity.type === 'app' && entity.name === template?.name; });
	if (existingApp) {
		throw new Error(`App already installed.`);
	}

	await plugin.updateJobProgress(job, `${template.title} installation starting...`);
	await plugin.updateJobProgress(job, `Downloading ${template.title} project template...`);
	const response = await fetch(plugin.getRawGitHubUrl(template.repository.url, template.repository.stackfile));
	const stack = await response.text();
	let env = Object.entries(config.env).map(([key, value]) => `${key}='${value}'`).join('\n');
	const composeProjectDir = path.join(plugin.composeDir, template.name);
	await plugin.updateJobProgress(job, `Making ${template.title} project directory...`);
	fs.mkdirSync(composeProjectDir, { recursive: true });
	await plugin.updateJobProgress(job, `Writing ${template.title} project template...`);
	fs.writeFileSync(path.join(composeProjectDir, 'docker-compose.yml'), stack, 'utf-8', { flag: 'w' });
	await plugin.updateJobProgress(job, `Writing ${template.title} project configuration...`);
	fs.writeFileSync(path.join(composeProjectDir, '.env'), env, 'utf-8', { flag: 'w' });
	await plugin.updateJobProgress(job, `Installing ${template.title}...`);
	await dockerCompose.upAll({
		cwd: composeProjectDir,
		callback: async (chunk) => {
			await plugin.updateJobProgress(job, chunk.toString());
		}
	});

	const icon = template.logo.split('/').pop();
	const responseIcon = await fetch(template.logo);
	await streamPipeline(responseIcon.body, fs.createWriteStream(`/var/www/virgo-ui/app/dist/assets/img/apps/${icon}`));
	let configuration = [...plugin.getState('configured')?.configuration ?? []]; // need to clone so we don't modify the reference
	const app = {
		name: template.name,
		type: 'app',
		canBeRemoved: true,
		category: template.categories.find((_, index) => { return index === 0; }),
		icon: icon,
		title: template.title
	};
	configuration.push(app);
	await plugin.updateJobProgress(job, `Updating apps configuration...`);
	fs.writeFileSync(plugin.dataFile, JSON.stringify({ configuration }, null, 2), 'utf-8', { flag: 'w' });
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
