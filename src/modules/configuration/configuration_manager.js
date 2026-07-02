const sanitizeFleetConfig = (fleet, connected) => {
	if (!fleet) {
		return null;
	}
	return {
		enabled: Boolean(fleet.enabled),
		email: fleet.email || null,
		registered: Boolean(fleet.token),
		connected: Boolean(connected)
	};
};

const emitToSocket = (socket, module) => {
	try {
		const source = module.getState('configuration') || {};
		let configuration = source;
		if (!socket.isAuthenticated || !socket.isAdmin) {
			configuration = { ...source };
			delete configuration.smtp;
			delete configuration.trustedProxies;
			delete configuration.fleet;
		} else if (source.fleet) {
			configuration = {
				...source,
				fleet: sanitizeFleetConfig(source.fleet, module.getState('fleetConnected'))
			};
		}
		socket.emit('configuration', configuration);
	} catch (error) {
		console.error(`Error emitting configuration to socket:`, error);
	}
};

const broadcast = (module) => {
	try {
		for (const socket of module.nsp.sockets.values()) {
			emitToSocket(socket, module);
		}
	} catch (error) {
		console.error(`Error broadcasting configuration:`, error);
	}
};

export default {
	name: 'configuration_manager',
	emitToSocket,
	broadcast
};
