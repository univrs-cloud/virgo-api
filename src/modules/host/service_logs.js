import { execa } from 'execa';

const OUTPUT_IDLE_MS = 10;
const OUTPUT_MAX_WAIT_MS = 250;

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
	session.flushOutput();
	activeSessions.delete(socket);
	socket.emit('host:service:logs:disconnected');
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

			socket.emit('host:service:logs:output', pendingLines);
			pendingLines = [];
		};
		const scheduleFlush = () => {
			clearTimeout(idleTimer);
			idleTimer = setTimeout(flushOutput, OUTPUT_IDLE_MS);
			if (!maxWaitTimer) {
				maxWaitTimer = setTimeout(flushOutput, OUTPUT_MAX_WAIT_MS);
			}
		};

		activeSessions.set(socket, {
			process: journalProcess,
			disconnectHandler,
			socketDisconnectHandler,
			flushOutput
		});

		let buffer = '';
		const emitLines = (chunk) => {
			buffer += chunk.toString('utf8');
			const lines = buffer.split('\n');
			buffer = lines.pop();
			if (lines.length === 0) {
				return;
			}

			pendingLines.push(...lines);
			scheduleFlush();
		};

		journalProcess.stdout.on('data', emitLines);
		journalProcess.stderr.on('data', emitLines);
		journalProcess.then(() => { cleanupSession(socket); }, () => { cleanupSession(socket); });

		socket.on('host:service:logs:disconnect', disconnectHandler);
		socket.on('disconnect', socketDisconnectHandler);

		socket.emit('host:service:logs:connected');
	} catch (error) {
		cleanupSession(socket);
		console.error('[host] Failed to start service logs stream:', error);
		socket.emit('host:service:logs:error', 'Failed to start service logs stream.');
	}
};

export default {
	name: 'service_logs',
	commands: {
		'host:service:logs:connect': {
			handler: (serviceName, socket) => { return serviceLogsConnect(socket, serviceName); }
		}
	}
};
