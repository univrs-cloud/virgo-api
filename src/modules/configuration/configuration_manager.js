const emitToSocket = (socket, module) => {
	try {
		const configuration = module.getState('configuration') || {};
		let userConfiguration = { ...configuration };
		if (!socket.isAuthenticated || !socket.isAdmin) {
			delete userConfiguration.smtp;
		}
		socket.emit('configuration', userConfiguration);
	} catch (error) {
		console.error(`Error emitting configuration to socket:`, error);
	}
};

const broadcast = (module) => {
	try {
		const configuration = module.getState('configuration') || {};
		for (const socket of module.getNsp().sockets.values()) {
			let userConfiguration = { ...configuration };
			if (!socket.isAuthenticated || !socket.isAdmin) {
				delete userConfiguration.smtp;
			}
			module.getNsp().to(`user:${socket.username}`).emit('configuration', userConfiguration);
		}
	} catch (error) {
		console.error(`Error broadcasting configuration:`, error);
	}
};

module.exports = {
	name: 'configuration_manager',
	emitToSocket,
	broadcast
};
