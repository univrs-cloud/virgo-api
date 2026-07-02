const emitToSocket = (socket, module) => {
	try {
		let configuration = module.getState('configuration') || {};
		if (!socket.isAuthenticated || !socket.isAdmin) {
			delete configuration.smtp;
			delete configuration.trustedProxies;
		}
		socket.emit('configuration', configuration);
	} catch (error) {
		console.error(`Error emitting configuration to socket:`, error);
	}
};

const broadcast = (module) => {
	try {
		let configuration = module.getState('configuration') || {};
		for (const socket of module.nsp.sockets.values()) {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				delete configuration.smtp;
				delete configuration.trustedProxies;
			}
			socket.emit('configuration', configuration);
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
