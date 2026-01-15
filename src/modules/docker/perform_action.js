const path = require('path');
const { execa } = require('execa');
const camelcaseKeys = require('camelcase-keys').default;
const docker = require('../../utils/docker_client');
const DataService = require('../../database/data_service');
const allowedAppActions = ['start', 'stop', 'kill', 'restart', 'recreate', 'uninstall'];
const allowedServiceActions = ['start', 'stop', 'kill', 'restart', 'pause', 'unpause'];

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
		action = ['up', '-d', '--force-recreate'];
	}
	if (config.action === 'uninstall') {
		action = ['down', '-v'];
	}
	const composeProjectDir = container.labels?.comDockerComposeProjectWorkingDir || path.join(module.composeDir, composeProject);
	await execa('docker', ['compose', ...action], {
		cwd: composeProjectDir
	});
	if (config.action === 'uninstall') {
		await DataService.deleteApplication(config.name);
		module.eventEmitter.emit('configured:updated');
		if (config.name === 'pcp') {
			module.eventEmitter.emit('metrics:disabled');
		}
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

	container.name = container.names[0].replace('/', '');
	const actionVerbs = module.nlp.conjugate(config.action);
	await module.updateJobProgress(job, `${container.name} service is ${actionVerbs.gerund}...`);
	await docker.getContainer(container.id)[config.action]();
	return `${container.name} service ${actionVerbs.pastTense}.`;
};

const register = (module) => {
	module.eventEmitter.on('app:uninstall:pcp', async ({ username }) => {
		await module.addJob('app:performAction', { config: { action: 'uninstall', name: 'pcp' }, username });
	});
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

module.exports = {
	name: 'perform_action',
	register,
	onConnection,
	jobs: {
		'app:performAction': performAppAction,
		'app:service:performAction': performServiceAction
	}
};
