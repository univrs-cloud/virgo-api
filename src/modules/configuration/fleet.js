import DataService from '../../database/data_service.js';

async function saveFleetConfiguration(module, fleet) {
	await DataService.setConfiguration('fleet', fleet);
	module.eventEmitter.emit('configuration:updated');
	module.eventEmitter.emit('fleet:sync');
}

const onConnection = (socket, module) => {
	socket.on('configuration:fleet:update', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		const configuration = await DataService.getConfiguration();
		const current = configuration?.fleet || {};
		const enabled = Boolean(config?.enabled);
		const email = String(config?.email || current.email || '').trim().toLowerCase() || null;

		// A first-time enable needs a token, which only exists after registering with the fleet.
		// The actual registration is owned by the fleet module; it emits `fleet:registered` back to
		// us with the token, which we then persist below.
		if (enabled && !current.token) {
			if (!email || !config?.password) {
				return;
			}
			module.eventEmitter.emit('fleet:register', { email, password: config.password });
			return;
		}

		await saveFleetConfiguration(module, { ...current, enabled, email });
	});
};

const onRegister = (module) => {
	// Persist fleet credentials once the fleet module has finished registering this node.
	module.eventEmitter.on('fleet:registered', async ({ email, nodeId, token } = {}) => {
		const configuration = await DataService.getConfiguration();
		const current = configuration?.fleet || {};
		await saveFleetConfiguration(module, {
			...current,
			enabled: true,
			email: email || current.email || null,
			nodeId,
			token
		});
	});

	// Reconnect using previously stored credentials at startup.
	module.eventEmitter.emit('fleet:sync');
};

export default {
	name: 'fleet',
	onConnection,
	register: onRegister
};
