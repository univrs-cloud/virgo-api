const emitToSocket = (socket, plugin) => {
	try {
		let configuration = plugin.getState('configuration') || {};
		let userConfiguration = { ...configuration };
		if (!socket.isAuthenticated || !socket.isAdmin) {
			delete userConfiguration.smtp;
		}
		socket.emit('configuration', userConfiguration);
	} catch (error) {
		console.error('Error emitting configuration to socket:', error);
	}
};

const broadcast = (plugin) => {
	try {
		let configuration = plugin.getState('configuration') || {};
		for (const socket of plugin.getNsp().sockets.values()) {
			let userConfiguration = { ...configuration };
			if (!socket.isAuthenticated || !socket.isAdmin) {
				delete userConfiguration.smtp;
			}
			plugin.getNsp().to(`user:${socket.username}`).emit('configuration', userConfiguration);
		}
	} catch (error) {
		console.error('Error broadcasting configuration:', error);
	}
};

module.exports = {
	name: 'configuration_manager',
	emitToSocket,
	broadcast
};
