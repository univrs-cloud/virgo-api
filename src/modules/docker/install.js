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

const instanceOf = (template, templates, env) => {
	if (template.multiple !== true) {
		return { name: template.name, title: template.title };
	}

	if (!(template.env || []).some((field) => { return String(field?.name ?? '').toLowerCase() === 'instance'; })) {
		throw new Error(`${template.title} can't be installed.`);
	}

	const [, value] = Object.entries(env || {}).find(([key]) => { return key.toLowerCase() === 'instance'; }) || [];
	const instance = String(value ?? '').toLowerCase();
	if (!validator.isAlphanumeric(instance)) {
		throw new Error(`'${instance}' is not a valid name. Use letters and numbers.`);
	}

	const name = `${template.name}-${instance}`;
	if (templates.some((template) => { return template.name.toLowerCase() === name; })) {
		throw new Error(`'${instance}' can't be used as a name.`);
	}

	return { name, title: `${template.title} (${instance})` };
};

const installApp = async (job, module) => {
	const { config } = job.data;
	const templates = module.toArray(module.getState('templates'));
	const template = templates.find((template) => { return template.name === config?.name; });
	if (!template) {
		throw new Error(`App template not found.`);
	}

	const { name, title } = instanceOf(template, templates, config?.env);

	// An imported pool arrives with its apps already in the registry, still configured for the name the
	// node had before. Forcing rewrites the project files and brings the stack back up on the current
	// one; the app's dataset, and everything it keeps there, is left alone.
	const existingApp = await DataService.getApplication(name);
	if (existingApp && !config?.force) {
		throw new Error(`App already installed.`);
	}

	await module.updateJobProgress(job, `${title} installation starting...`);
	const dataset = `${module.appsDataset}/${name}`;
	const appDir = path.join(module.appsDir, name);
	try {
		await fs.access(appDir);
		await module.updateJobProgress(job, `Storage space ${dataset} for ${title} already exists. Skipping creation.`);
	} catch (error) {
		if (error.code === 'ENOENT') {
			await module.updateJobProgress(job, `Creating storage space ${dataset} for ${title}...`);
			try {
				await execa('zfs', ['create', dataset]); // Only create dataset if not exists
				await module.updateJobProgress(job, `Storage space ${dataset} created for ${title}.`);
			} catch (error) {
				throw new Error(`Could not create storage space ${dataset} for ${title}.`);
			}
		}
	}
	await module.updateJobProgress(job, `Downloading ${title} project template...`);
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

			if (key.toLowerCase() === 'instance' && template.multiple === true) {
				return envLine(key, String(value ?? '').toLowerCase());
			}

			return envLine(key, value);
		})
		.join('\n');
	const composeProjectDir = path.join(module.appsDir, name, module.composeDir);
	await module.updateJobProgress(job, `Making ${title} project directory...`);
	await fs.mkdir(composeProjectDir, { recursive: true });
	await module.updateJobProgress(job, `Writing ${title} project template...`);
	await fs.writeFile(path.join(composeProjectDir, 'docker-compose.yml'), stack, 'utf-8');
	await module.updateJobProgress(job, `Writing ${title} project configuration...`);
	await fs.writeFile(path.join(composeProjectDir, '.env'), env, 'utf-8');
	
	await module.updateJobProgress(job, `Downloading ${title}...`);
	const parsePullProgress = dockerPullProgressParser();
	await dockerCompose.pullAll({
		cwd: composeProjectDir,
		composeOptions: [['-p', name], ['--progress', 'json']],
		callback: (chunk) => {
			const progress = parsePullProgress(chunk);
			if (progress) {
				module.updateJobProgress(job, `Downloading ${title}...`, progress);
			}
		}
	});
	await module.updateJobProgress(job, `Installing ${title}...`);
	await dockerCompose.upAll({
		cwd: composeProjectDir,
		composeOptions: [['-p', name]],
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
		name: name,
		canBeRemoved: !isCoreApp(name),
		category: template.categories.find((_, index) => { return index === 0; }),
		icon: icon,
		title: title
	};
	await module.updateJobProgress(job, `Updating apps registry...`);
	await DataService.setApplication(app);
	module.eventEmitter.emit('configured:updated');
	module.eventEmitter.emit('app:installed', { name });
	return `${title} installed.`;
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
