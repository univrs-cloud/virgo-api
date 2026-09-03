import { execa } from 'execa';

const reboot = async (socket, module) => {
	if (module.getState('reboot') !== undefined) {
		return;
	}

	module.setState('reboot', true);
	module.nsp.emit('host:reboot', true);
	try {
		await execa('reboot');
	} catch (error) {
		module.setState('reboot', false);
		module.nsp.emit('host:reboot', false);
	}
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

export default {
	name: 'power_management',
	onConnection
};
