const onConnection = (socket, module) => {
	socket.on('metrics:enable', async () => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		module.eventEmitter.emit('app:install:pcp', { username: socket.username });
	});
	socket.on('metrics:disable', async () => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		module.eventEmitter.emit('app:uninstall:pcp', { username: socket.username });
	});
};

module.exports = {
	name: 'perform_action',
	onConnection
};
