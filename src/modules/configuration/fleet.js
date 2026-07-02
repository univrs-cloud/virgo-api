import DataService from '../../database/data_service.js';
import eventEmitter from '../../utils/event_emitter.js';

const updateFleetConfiguration = async (job, module) => {
	const configuration = await DataService.getConfiguration();
	const current = configuration?.fleet || {};
	const enabled = Boolean(job.data.config?.enabled);
	const email = String(job.data.config?.email || current.email || '').trim().toLowerCase() || null;

	if (enabled && !current.token && (!email || !job.data.config?.password)) {
		throw new Error('Fleet email and password are required');
	}

	await DataService.setConfiguration('fleet', {
		...current,
		enabled,
		email
	});

	if (enabled && !current.token) {
		eventEmitter.emit('fleet:register', {
			email,
			password: job.data.config.password
		});
	}

	module.eventEmitter.emit('configuration:updated');
	return 'Fleet configuration saved.';
};

const onConnection = (socket, module) => {
	socket.on('configuration:fleet:update', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('fleet:update', { config, username: socket.username });
	});
};

export default {
	name: 'fleet',
	onConnection,
	jobs: {
		'fleet:update': updateFleetConfiguration
	}
};
