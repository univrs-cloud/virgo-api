import { createWriteStream, promises as fs } from 'fs';
import path from 'path';
import stream from 'stream';
import { promisify } from 'util';
import { execa } from 'execa';
import dockerCompose from 'docker-compose';
import validator from 'validator';
import dockerPullProgressParser from '../../utils/docker_pull_progress_parser.js';
import DataService from '../../database/data_service.js';
import { isCoreApp } from '../../utils/core_apps.js';

const streamPipeline = promisify(stream.pipeline);
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const envLine = (key, value) => {
	const escaped = String(value ?? '')
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\$/g, '\\$')
		.replace(/\r/g, '\\r')
		.replace(/\n/g, '\\n');
	return `${key}="${escaped}"`;
};

const installApp = async (job, module) => {
	const { config } = job.data;
	const template = module.toArray(module.getState('templates')).find((template) => { return template.name === config?.name; });
	if (!template) {
		throw new Error(`App template not found.`);
	}

	// An imported pool arrives with its apps already in the registry, still configured for the name the
	// node had before. Forcing rewrites the project files and brings the stack back up on the current
	// one; the app's dataset, and everything it keeps there, is left alone.
	const existingApp = await DataService.getApplication(template?.name);
	if (existingApp && !config?.force) {
		throw new Error(`App already installed.`);
	}

	await module.updateJobProgress(job, `${template.title} installation starting...`);
	const dataset = `${module.appsDataset}/${template.name}`;
	const appDir = path.join(module.appsDir, template.name);
	try {
		await fs.access(appDir);
		await module.updateJobProgress(job, `Storage space ${dataset} for ${template.title} already exists. Skipping creation.`);
	} catch (error) {
		if (error.code === 'ENOENT') {
			await module.updateJobProgress(job, `Creating storage space ${dataset} for ${template.title}...`);
			try {
				await execa('zfs', ['create', dataset]); // Only create dataset if not exists
				await module.updateJobProgress(job, `Storage space ${dataset} created for ${template.title}.`);
			} catch (error) {
				throw new Error(`Could not create storage space ${dataset} for ${template.title}.`);
			}
		}
	}
	await module.updateJobProgress(job, `Downloading ${template.title} project template...`);
	const response = await fetch(`${template.repository.url}${template.repository.stackfile}`);
	if (!response.ok) {
		throw new Error(`Failed to download app template: ${response.status} ${response.statusText}`);
	}
	
	const stack = await response.text();
	const env = Object.entries(config?.env || {})
		.map(([key, value]) => {
			if (!ENV_KEY_PATTERN.test(key)) {
				throw new Error(`Invalid environment variable name: ${key}`);
			}

			if (key.toLowerCase() === 'domain' && !validator.isFQDN(String(value ?? ''), { require_tld: false })) {
				throw new Error(`'${value}' is not a valid domain name.`);
			}

			return envLine(key, value);
		})
		.join('\n');
	const composeProjectDir = path.join(module.composeDir, template.name);
	await module.updateJobProgress(job, `Making ${template.title} project directory...`);
	await fs.mkdir(composeProjectDir, { recursive: true });
	await module.updateJobProgress(job, `Writing ${template.title} project template...`);
	await fs.writeFile(path.join(composeProjectDir, 'docker-compose.yml'), stack, 'utf-8');
	await module.updateJobProgress(job, `Writing ${template.title} project configuration...`);
	await fs.writeFile(path.join(composeProjectDir, '.env'), env, 'utf-8');
	
	await module.updateJobProgress(job, `Downloading ${template.title}...`);
	const parsePullProgress = dockerPullProgressParser();
	await dockerCompose.pullAll({
		cwd: composeProjectDir,
		composeOptions: [['--progress', 'json']],
		callback: (chunk) => {
			const progress = parsePullProgress(chunk);
			if (progress) {
				module.updateJobProgress(job, `Downloading ${template.title}...`, progress);
			}
		}
	});
	await module.updateJobProgress(job, `Installing ${template.title}...`);
	await dockerCompose.upAll({
		cwd: composeProjectDir,
		commandOptions: ['--remove-orphans'],
		callback: (chunk) => {
			module.updateJobProgress(job, chunk.toString());
		}
	});

	const icon = template.logo.split('/').pop();
	await fs.mkdir(module.appIconsDir, { recursive: true });
	const responseIcon = await fetch(template.logo);
	if (responseIcon.ok) {
		await streamPipeline(responseIcon.body, createWriteStream(path.join(module.appIconsDir, icon)));
	}
	const app = {
		name: template.name,
		canBeRemoved: !isCoreApp(template.name),
		category: template.categories.find((_, index) => { return index === 0; }),
		icon: icon,
		title: template.title
	};
	await module.updateJobProgress(job, `Updating apps registry...`);
	await DataService.setApplication(app);
	module.eventEmitter.emit('configured:updated');
	module.eventEmitter.emit('app:installed', { name: template.name });
	return `${template.title} installed.`;
};

export default {
	name: 'install',
	commands: {
		'app:install': { job: 'app:install' }
	},
	jobs: {
		'app:install': installApp
	}
};
