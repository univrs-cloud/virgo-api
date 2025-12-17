const stream = require('stream');
const docker = require('../../utils/docker_client');

// Track active log sessions per socket to clean up listeners
const activeSessions = new WeakMap();

const cleanupSession = (socket) => {
	const session = activeSessions.get(socket);
	if (!session) {
		return;
	}
	
	socket.off('logs:disconnect', session.disconnectHandler);
	socket.off('disconnect', session.socketDisconnectHandler);
	session.logsStream?.destroy();
	activeSessions.delete(socket);
};

const logsConnect = async (socket, containerId) => {
	try {
		// Clean up any existing session first
		cleanupSession(socket);

		const container = docker.getContainer(containerId);
		if (!container) {
			return;
		}
		
		const logsStream = await container.logs(
			{
				follow: true,
				stdout: true,
				stderr: true,
				tail: 100
			}
		);

		// Define handlers so they can be removed later
		const disconnectHandler = () => {
			cleanupSession(socket);
		};
		const socketDisconnectHandler = () => {
			cleanupSession(socket);
		};

		// Store session for cleanup
		activeSessions.set(socket, {
			logsStream,
			disconnectHandler,
			socketDisconnectHandler
		});

		// Pipe container output to the client
		// Create readable streams for stdout and stderr
		const stdout = new stream.PassThrough();
		const stderr = new stream.PassThrough();
		stdout.on('data', (data) => { socket.emit('logs:output', data.toString('utf8')) });
		stderr.on('data', (data) => { socket.emit('logs:output', data.toString('utf8')) });
		docker.modem.demuxStream(logsStream, stdout, stderr);

		// Handle stream end/error
		logsStream.on('end', () => cleanupSession(socket));
		logsStream.on('error', () => cleanupSession(socket));

		// Client terminated the connection
		socket.on('logs:disconnect', disconnectHandler);
		socket.on('disconnect', socketDisconnectHandler);

		socket.emit('logs:connected');
	} catch (error) {
		cleanupSession(socket);
		socket.emit('logs:error', 'Failed to start container logs stream.');
	}
};

const onConnection = (socket, module) => {
	socket.on('logs:connect', (containerId) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		
		logsConnect(socket, containerId); 
	});
};

module.exports = {
	name: 'logs',
	onConnection
};
