const { execa } = require('execa');

const reboot = async (socket, module) => {
	if (module.getState('reboot') !== undefined) {
		return;
	}

	try {
		await execa('reboot');
		module.setState('reboot', true);
	} catch (error) {
		module.setState('reboot', false);
	}

	module.nsp.emit('host:reboot', module.getState('reboot'));
};

const shutdown = async (socket, module) => {
	if (module.getState('shutdown') !== undefined) {
		return;
	}

	try {
		await execa('shutdown', ['-h', 'now']);
		module.setState('shutdown', true);
	} catch (error) {
		module.setState('shutdown', false);
	}

	module.nsp.emit('host:shutdown', module.getState('shutdown'));
};

const onConnection = (socket, module) => {
	socket.on('host:reboot', () => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		reboot(socket, module); 
	});
	socket.on('host:shutdown', () => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		shutdown(socket, module); 
	});
};

module.exports = {
	name: 'power_management',
	onConnection
};
