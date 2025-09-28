const { execa } = require('execa');
const dockerode = require('dockerode');
const DataService = require('../../database/data_service');

const docker = new dockerode();
const allowedActions = ['start', 'stop', 'kill', 'restart', 'down'];

const performAppAction = async (job, plugin) => {
	let config = job.data.config;
	if (!allowedActions.includes(config?.action)) {
		throw new Error(`Not allowed to perform ${config?.action} on apps.`);
	}

	const existingApp = await DataService.getApplication(config?.name);
	if (!existingApp) {
		throw new Error(`App not found.`);
	}

	await plugin.updateJobProgress(job, `${existingApp.title} app is ${config.action}ing...`);

	const container = plugin.getState('containers')?.find((container) => {
		return container.names.includes(`/${config.name}`);
	});
	const composeProject = container.labels.comDockerComposeProject ?? false;
	if (composeProject === false) {
		throw new Error(`${existingApp.title} app is not set up to perform ${config.action}.`);
	}

	await execa('docker', ['compose', '-p', composeProject, config.action]);
	if (config.action === 'down') {
		await DataService.deleteApplication(config.name);
		plugin.getInternalEmitter().emit('configured:updated');
	}
	
	return `${existingApp.title} app ${config.action}ed.`;
};

const performServiceAction = async (job, plugin) => {
	let config = job.data.config;
	if (!allowedActions.includes(config?.action)) {
		throw new Error(`Not allowed to perform ${config?.action} on services.`);
	}

	const container = plugin.getState('containers')?.find((container) => {
		return container.id === config?.id;
	});
	if (!container) {
		throw new Error(`Service not found.`);
	}

	await plugin.updateJobProgress(job, `${container.name} service is ${config.action}ing...`);
	await docker.getContainer(container.id)[config.action]();
	return `${container.name} service ${config.action}ed.`;
};

module.exports = {
	name: 'perform_action',
	onConnection(socket, plugin) {
		socket.on('app:performAction', async (config) => {
			await plugin.handleDockerAction(socket, 'app:performAction', config);
		});
		socket.on('service:performAction', async (config) => {
			await plugin.handleDockerAction(socket, 'service:performAction', config);
		});
	},
	jobs: {
		'app:performAction': performAppAction,
		'service:performAction': performServiceAction
	}
};
