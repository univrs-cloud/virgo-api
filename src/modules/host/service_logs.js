const { execa } = require('execa');

// Track active log sessions per socket to clean up listeners
const activeSessions = new WeakMap();

const cleanupSession = (socket) => {
	const session = activeSessions.get(socket);
	if (!session) {
		return;
	}

	socket.off('host:service:logs:disconnect', session.disconnectHandler);
	socket.off('disconnect', session.socketDisconnectHandler);
	session.process?.kill();
	activeSessions.delete(socket);
};

const serviceLogsConnect = async (socket, serviceName) => {
	try {
		cleanupSession(socket);

		const journalProcess = execa('journalctl', ['-u', serviceName, '-f', '-n', '200', '--output=short-precise'], {
			reject: false
		});

		const disconnectHandler = () => {
			cleanupSession(socket);
		};
		const socketDisconnectHandler = () => {
			cleanupSession(socket);
		};

		activeSessions.set(socket, {
			process: journalProcess,
			disconnectHandler,
			socketDisconnectHandler
		});

		let buffer = '';
		const emitLines = (chunk) => {
			buffer += chunk.toString('utf8');
			const lines = buffer.split('\n');
			buffer = lines.pop();
			for (const line of lines) {
				socket.emit('host:service:logs:output', line + '\n');
			}
		};

		journalProcess.stdout.on('data', emitLines);
		journalProcess.stderr.on('data', emitLines);

		journalProcess.on('close', () => cleanupSession(socket));
		journalProcess.on('error', () => cleanupSession(socket));

		socket.on('host:service:logs:disconnect', disconnectHandler);
		socket.on('disconnect', socketDisconnectHandler);

		socket.emit('host:service:logs:connected');
	} catch (error) {
		cleanupSession(socket);
		socket.emit('host:service:logs:error', 'Failed to start service logs stream.');
	}
};

const onConnection = (socket, module) => {
	socket.on('host:service:logs:connect', (serviceName) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		serviceLogsConnect(socket, serviceName);
	});
};

module.exports = {
	name: 'service_logs',
	onConnection
};
