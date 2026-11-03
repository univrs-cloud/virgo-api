import stream from 'stream';
import docker from '../../utils/docker_client.js';

const OUTPUT_IDLE_MS = 10;
const OUTPUT_MAX_WAIT_MS = 250;

// Track active log sessions per socket to clean up listeners
const activeSessions = new WeakMap();

const cleanupSession = (socket) => {
	const session = activeSessions.get(socket);
	if (!session) {
		return;
	}
	
	socket.off('docker:container:logs:disconnect', session.disconnectHandler);
	socket.off('disconnect', session.socketDisconnectHandler);
	session.logsStream?.destroy();
	session.flushOutput();
	activeSessions.delete(socket);
	// A container restarting ends the stream, which is the common way this session dies. Without
	// telling the client, it goes on showing the stream as live and never offers the reconnect link.
	socket.emit('docker:container:logs:disconnected');
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
				timestamps: true,
				tail: 200
			}
		);

		// Define handlers so they can be removed later
		const disconnectHandler = () => {
			cleanupSession(socket);
		};
		const socketDisconnectHandler = () => {
			cleanupSession(socket);
		};

		let pendingLines = [];
		let idleTimer = null;
		let maxWaitTimer = null;
		const flushOutput = () => {
			clearTimeout(idleTimer);
			clearTimeout(maxWaitTimer);
			idleTimer = null;
			maxWaitTimer = null;
			if (pendingLines.length === 0) {
				return;
			}

			socket.emit('docker:container:logs:output', pendingLines);
			pendingLines = [];
		};
		const scheduleFlush = () => {
			clearTimeout(idleTimer);
			idleTimer = setTimeout(flushOutput, OUTPUT_IDLE_MS);
			if (!maxWaitTimer) {
				maxWaitTimer = setTimeout(flushOutput, OUTPUT_MAX_WAIT_MS);
			}
		};
		const queueOutput = (data) => {
			pendingLines.push(data.toString('utf8'));
			scheduleFlush();
		};

		// Store session for cleanup
		activeSessions.set(socket, {
			logsStream,
			disconnectHandler,
			socketDisconnectHandler,
			flushOutput
		});

		// Pipe container output to the client
		// Create readable streams for stdout and stderr
		const stdout = new stream.PassThrough();
		const stderr = new stream.PassThrough();
		stdout.on('data', queueOutput);
		stderr.on('data', queueOutput);
		docker.modem.demuxStream(logsStream, stdout, stderr);

		// Handle stream end/error
		logsStream.on('end', () => cleanupSession(socket));
		logsStream.on('error', () => cleanupSession(socket));

		// Client terminated the connection
		socket.on('docker:container:logs:disconnect', disconnectHandler);
		socket.on('disconnect', socketDisconnectHandler);

		socket.emit('docker:container:logs:connected');
	} catch (error) {
		cleanupSession(socket);
		socket.emit('docker:container:logs:error', 'Failed to start container logs stream.');
	}
};

export default {
	name: 'logs',
	commands: {
		'docker:container:logs:connect': {
			handler: (containerId, socket) => { return logsConnect(socket, containerId); }
		}
	}
};
