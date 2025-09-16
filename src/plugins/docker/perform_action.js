const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const dockerode = require('dockerode');

const docker = new dockerode();
const allowedActions = ['start', 'stop', 'kill', 'restart', 'down'];

const performAppAction = async (job, plugin) => {
	let config = job.data.config;
	if (!allowedActions.includes(config?.action)) {
		throw new Error(`Not allowed to perform ${config?.action} on apps.`);
	}

	const existingApp = plugin.getState('configured')?.configuration.find((entity) => { return entity.type === 'app' && entity.name === config?.name; });
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

	await exec(`docker compose -p ${composeProject} ${config.action}`);
	if (config.action === 'down') {
		let configuration = [...plugin.getState('configured')?.configuration ?? []]; // need to clone so we don't modify the reference
		configuration = configuration.filter((entity) => { return entity.name !== config.name });
		fs.writeFileSync(plugin.dataFile, JSON.stringify({ configuration }, null, 2), 'utf-8', { flag: 'w' });
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
