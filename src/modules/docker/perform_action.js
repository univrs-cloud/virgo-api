import path from 'path';
import { promises as fs } from 'fs';
import { execa } from 'execa';
import camelcaseKeys from 'camelcase-keys';
import docker from '../../utils/docker_client.js';
import DataService from '../../database/data_service.js';
const allowedAppActions = ['start', 'stop', 'kill', 'restart', 'recreate', 'uninstall'];
const allowedServiceActions = ['start', 'stop', 'kill', 'restart', 'pause', 'unpause'];

/** Recreating is how a broken or outdated app is put back together, so it is built from the template
 * again rather than from whatever is on disk. The project's `.env` is left alone: that is the
 * configuration this node was given, not something the catalogue decides. A template that cannot be
 * reached leaves the existing file in place — recreating from it still fixes a container, and losing
 * that on a node with no internet would be worse than being a version behind. */
const downloadComposeFile = async (job, module, name, composeProjectDir) => {
	const template = module.toArray(module.getState('templates')).find((template) => { return template.name === name; });
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
	if (!existingApp) {
		throw new Error(`App not found.`);
	}

	const actionVerbs = module.nlp.conjugate(config.action);
	await module.updateJobProgress(job, `${existingApp.title} app is ${actionVerbs.gerund}...`);
	const containers = await module.findContainersByAppName(config.name);
	if (containers.length === 0) {
		throw new Error(`Containers for app '${config.name}' not found.`);
	}
	
	const container = containers[0];
	const composeProject = container.labels?.comDockerComposeProject ?? false;
	if (composeProject === false) {
		throw new Error(`${existingApp.title} app is not set up to perform ${config.action} action.`);
	}
		
	let action = [config.action];
	if (config.action === 'recreate') {
		action = ['up', '-d', '--force-recreate', '--remove-orphans'];
	}
	if (config.action === 'uninstall') {
		action = ['down', '-v'];
	}
	const composeProjectDir = container.labels?.comDockerComposeProjectWorkingDir || path.join(module.composeDir, composeProject);
	if (config.action === 'recreate') {
		await downloadComposeFile(job, module, config.name, composeProjectDir);
	}

	await execa('docker', ['compose', ...action], {
		cwd: composeProjectDir
	});
	if (config.action === 'uninstall') {
		await DataService.deleteApplication(config.name);
		module.eventEmitter.emit('configured:updated');
	}
	return `${existingApp.title} app ${actionVerbs.pastTense}.`;
};

const performServiceAction = async (job, module) => {
	const { config } = job.data;
	if (!allowedServiceActions.includes(config?.action)) {
		throw new Error(`Not allowed to perform ${config?.action} on services.`);
	}

	let containers = await docker.listContainers({ all: true });
	containers = camelcaseKeys(containers, { deep: true });
	const container = containers.find((container) => { return container.id === config?.id; });
	if (!container) {
		throw new Error(`Service not found.`);
	}
	
	const serviceName = container.labels?.comDockerComposeService;
	const actionVerbs = module.nlp.conjugate(config.action);
	await module.updateJobProgress(job, `${serviceName} service is ${actionVerbs.gerund}...`);
	await docker.getContainer(container.id)[config.action]();
	return `${serviceName} service ${actionVerbs.pastTense}.`;
};

const onConnection = (socket, module) => {
	socket.on('app:performAction', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('app:performAction', { config, username: socket.username });
	});
	socket.on('app:service:performAction', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('app:service:performAction', { config, username: socket.username });
	});
};

export default {
	name: 'perform_action',
	onConnection,
	jobs: {
		'app:performAction': performAppAction,
		'app:service:performAction': performServiceAction
	}
};
