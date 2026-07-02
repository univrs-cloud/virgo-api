import DataService from '../../database/data_service.js';

const waitForFleetRegistration = (module, credentials) => {
	return new Promise((resolve, reject) => {
		const onRegistered = (payload) => {
			cleanup();
			resolve(payload);
		};
		const onError = ({ error } = {}) => {
			cleanup();
			reject(new Error(error || 'Node registration failed'));
		};
		const cleanup = () => {
			module.eventEmitter.off('fleet:registered', onRegistered);
			module.eventEmitter.off('fleet:register:error', onError);
		};

		module.eventEmitter.once('fleet:registered', onRegistered);
		module.eventEmitter.once('fleet:register:error', onError);
		module.eventEmitter.emit('fleet:register', credentials);
	});
};

const updateFleetConfiguration = async (job, module) => {
	const configuration = await DataService.getConfiguration();
	const current = configuration?.fleet || {};
	const enabled = Boolean(job.data.config?.enabled);
	const email = String(job.data.config?.email || current.email || '').trim().toLowerCase() || null;

	if (enabled && !current.token && (!email || !job.data.config?.password)) {
		throw new Error('Fleet email and password are required');
	}

	let updated;
	let message;
	if (enabled && !current.token) {
		await module.updateJobProgress(job, 'Registering with fleet...');
		let response;
		try {
			response = await waitForFleetRegistration(module, {
				email,
				password: job.data.config.password
			});
		} catch (error) {
			throw new Error(`Unable to register with fleet: ${error.message}`);
		}
		updated = {
			...current,
			enabled: true,
			email,
			nodeId: response.nodeId,
			token: response.token
		};
		message = 'Registered with fleet.';
	} else {
		updated = {
			...current,
			enabled,
			email
		};
		message = (enabled ? 'Fleet configuration saved.' : 'Fleet disabled.');
	}

	await DataService.setConfiguration('fleet', updated);
	module.eventEmitter.emit('configuration:updated');

	if (updated.enabled) {
		await module.updateJobProgress(job, 'Connecting to fleet...');
	}
	module.eventEmitter.emit('fleet:sync');

	return message;
};

const onConnection = (socket, module) => {
	socket.on('configuration:fleet:update', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('fleet:update', { config, username: socket.username });
	});
};

const register = (module) => {
	module.eventEmitter.emit('fleet:sync');
};

export default {
	name: 'fleet',
	onConnection,
	register,
	jobs: {
		'fleet:update': updateFleetConfiguration
	}
};
