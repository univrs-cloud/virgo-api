const { execa } = require('execa');
const docker = require('../../utils/docker_client');
const DataService = require('../../database/data_service');
const allowedActions = ['start', 'stop', 'kill', 'restart', 'recreate', 'uninstall'];

const performAppAction = async (job, module) => {
	const config = job.data.config;
	if (!allowedActions.includes(config?.action)) {
		throw new Error(`Not allowed to perform ${config?.action} on apps.`);
	}

	const existingApp = await DataService.getApplication(config?.name);
	if (!existingApp) {
		throw new Error(`App not found.`);
	}

	const actionVerbs = module.nlp.conjugate(config.action);
	await module.updateJobProgress(job, `${existingApp.title} app is ${actionVerbs.gerund}...`);
	const container = module.getState('containers')?.find((container) => { return container.names.includes(`/${config.name}`); });
	const composeProject = container?.labels?.comDockerComposeProject ?? false;
	if (composeProject === false) {
		throw new Error(`${existingApp.title} app is not set up to perform ${config.action} action.`);
	}
	let action = [config.action];
	if (config.action === 'recreate') {
		action = ['up', '-d', '--force-recreate'];
	}
	if (config.action === 'uninstall') {
		action = ['down'];
	}
	await execa('docker', ['compose', '-f', module.composeFile(composeProject), ...action]);
	if (config.action === 'uninstall') {
		await DataService.deleteApplication(config.name);
		module.eventEmitter.emit('configured:updated');
	}
	return `${existingApp.title} app ${actionVerbs.pastTense}.`;
};

const performServiceAction = async (job, module) => {
	const config = job.data.config;
	if (!allowedActions.includes(config?.action)) {
		throw new Error(`Not allowed to perform ${config?.action} on services.`);
	}

	const container = module.getState('containers')?.find((container) => { return container.id === config?.id; });
	if (!container) {
		throw new Error(`Service not found.`);
	}

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
