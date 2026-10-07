import path from 'path';
import { promises as fs } from 'fs';
import { execa } from 'execa';
import camelcaseKeys from 'camelcase-keys';
import docker from '../../utils/docker_client.js';
import DataService from '../../database/data_service.js';

const allowedAppActions = ['start', 'stop', 'kill', 'restart', 'recreate', 'uninstall'];
const allowedServiceActions = ['start', 'stop', 'kill', 'restart', 'pause', 'unpause', 'remove'];
const allowedUnmanagedActions = ['start', 'stop', 'kill', 'restart'];

/** Recreating is how a broken or outdated app is put back together, so it is built from the template
 * again rather than from whatever is on disk. The project's `.env` is left alone: that is the
 * configuration this node was given, not something the catalogue decides. A template that cannot be
 * reached leaves the existing file in place — recreating from it still fixes a container, and losing
 * that on a node with no internet would be worse than being a version behind. */
const downloadComposeFile = async (job, module, name, composeProjectDir) => {
	const template = module.findTemplateByAppName(await module.getTemplates(), name);
	if (!template) {
		return;
	}

	await module.updateJobProgress(job, `Downloading ${template.title} project template...`);
	try {
		const response = await fetch(`${template.repository.url}${template.repository.stackfile}`);
		if (!response.ok) {
			throw new Error(`${response.status} ${response.statusText}`);
		}

		await fs.writeFile(path.join(composeProjectDir, 'docker-compose.yml'), await response.text(), 'utf-8');
	} catch (error) {
		console.error(`Could not download the ${name} project template: ${error.message}`);
		await module.updateJobProgress(job, `Could not download ${template.title}'s project template, recreating from cache...`);
	}
};

const performAppAction = async (job, module) => {
	const { config } = job.data;
	if (!allowedAppActions.includes(config?.action)) {
		throw new Error(`Not allowed to perform ${config?.action} on apps.`);
	}

	const existingApp = await DataService.getApplication(config?.name);
	if (!existingApp && !allowedUnmanagedActions.includes(config.action)) {
		throw new Error(`App not found.`);
	}

	const title = existingApp?.title || config.name;
	const actionVerbs = module.nlp.conjugate(config.action);
	await module.updateJobProgress(job, `${title} app is ${actionVerbs.gerund}...`);
	const containers = await module.findContainersByAppName(config.name);
	if (containers.length === 0) {
		throw new Error(`Containers for app '${config.name}' not found.`);
	}
	
	const container = containers[0];
	const composeProject = container.labels?.comDockerComposeProject ?? false;
	if (composeProject === false) {
		throw new Error(`${title} app is not set up to perform ${config.action} action.`);
	}
	
	let action = [config.action];
	if (config.action === 'recreate') {
		action = ['up', '-d', '--force-recreate', '--remove-orphans'];
	}
	if (config.action === 'uninstall') {
		action = ['down', '-v'];
	}
	const composeProjectDir = container.labels?.comDockerComposeProjectWorkingDir || path.join(module.appsDir, composeProject, module.composeDir);
	if (config.action === 'recreate') {
		await downloadComposeFile(job, module, config.name, composeProjectDir);
	}
	
	const composeFiles = (existingApp ? [] : (container.labels?.comDockerComposeProjectConfigFiles || '').split(',').filter(Boolean));
	await execa('docker', ['compose', '-p', composeProject, ...composeFiles.flatMap((file) => { return ['-f', file]; }), ...action], {
		cwd: composeProjectDir
	});
	if (config.action === 'uninstall') {
		await DataService.deleteApplication(config.name);
		module.eventEmitter.emit('configured:updated');
	}
	return `${title} app ${actionVerbs.pastTense}.`;
};

const findContainer = async (id) => {
	const containers = camelcaseKeys(await docker.listContainers({ all: true }), { deep: true });
	return containers.find((container) => { return container.id === id; });
};

const performServiceAction = async (job, module) => {
	const { config } = job.data;
	if (!allowedServiceActions.includes(config?.action)) {
		throw new Error(`Not allowed to perform ${config?.action} on services.`);
	}

	const container = await findContainer(config?.id);
	if (!container) {
		throw new Error(`Service not found.`);
	}

	if (config.action === 'remove' && container.labels?.comDockerComposeProject) {
		throw new Error(`Not allowed to perform ${config.action} on services.`);
	}
	
	const serviceName = container.labels?.comDockerComposeService || container.names?.[0]?.replace(/^\//, '');
	const actionVerbs = module.nlp.conjugate(config.action);
	await module.withAppLock(container.labels?.comDockerComposeProject || container.id, async () => {
		if (!(await findContainer(container.id))) {
			throw new Error(`Service not found.`);
		}

		await module.updateJobProgress(job, `${serviceName} service is ${actionVerbs.gerund}...`);
		if (config.action === 'remove') {
			await docker.getContainer(container.id).remove({ force: true });
		} else {
			await docker.getContainer(container.id)[config.action]();
		}
	});
	return `${serviceName} service ${actionVerbs.pastTense}.`;
};

export default {
	name: 'perform_action',
	commands: {
		'app:service:performAction': { job: 'app:service:performAction', parallel: true },
		'app:performAction': { job: 'app:performAction', parallel: (config) => { return String(config?.action ?? '').toLowerCase() !== 'recreate'; } }
	},
	jobs: {
		'app:performAction': (job, module) => {
			return module.withAppLock(job.data?.config?.name, () => { return performAppAction(job, module); });
		},
		'app:service:performAction': performServiceAction
	}
};
