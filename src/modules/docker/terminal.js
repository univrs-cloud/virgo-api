const { execa } = require('execa');
const stream = require('stream');
const dockerode = require('dockerode');

const docker = new dockerode();

// Track active terminal sessions per socket to clean up listeners
const activeSessions = new WeakMap();

const cleanupSession = (socket) => {
	const session = activeSessions.get(socket);
	if (!session) {
		return;
	}

	socket.off('terminal:input', session.inputHandler);
	socket.off('terminal:resize', session.resizeHandler);
	socket.off('terminal:disconnect', session.disconnectHandler);
	socket.off('disconnect', session.socketDisconnectHandler);
	session.terminalStream?.destroy();
	activeSessions.delete(socket);
};

const terminalConnect = async (socket, containerId) => {
	try {
		// Clean up any existing session first
		cleanupSession(socket);

		const container = docker.getContainer(containerId);
		if (!container) {
			return;
		}

		let shell = await findContainerShell(containerId);
		if (!shell) {
			socket.emit('terminal:error', 'No compatible shell found in container.');
			return;
		}
		
		const containerExec = await container.exec(
			{
				Cmd: [`/bin/${shell}`],
				AttachStdin: true,
				AttachStdout: true,
				AttachStderr: true,
				Tty: true
			}
		);
		const terminalStream = await containerExec.start(
			{
				stream: true,
				stdin: true,
				stdout: true,
				stderr: true,
				hijack: true
			}
		);

		// Define handlers so they can be removed later
		const inputHandler = (data) => {
			if (!terminalStream.destroyed) {
				terminalStream.write(data);
			}
		};
		const resizeHandler = (size) => {
			containerExec.resize({
				h: size.rows,
				w: size.cols
			}).catch(() => {
				// Container or exec session may no longer exist - ignore
			});
		};
		const disconnectHandler = () => {
			cleanupSession(socket);
		};
		const socketDisconnectHandler = () => {
			cleanupSession(socket);
		};

		// Store session for cleanup
		activeSessions.set(socket, {
			terminalStream,
			inputHandler,
			resizeHandler,
			disconnectHandler,
			socketDisconnectHandler
		});

		// Pipe container output to the client
		// Create readable streams for stdout and stderr
		const stdout = new stream.PassThrough();
		const stderr = new stream.PassThrough();
		stdout.on('data', (data) => { socket.emit('terminal:output', data.toString('utf8')) });
		stderr.on('data', (data) => { socket.emit('terminal:output', data.toString('utf8')) });
		docker.modem.demuxStream(terminalStream, stdout, stderr);

		// Handle stream end/error
		terminalStream.on('end', () => cleanupSession(socket));
		terminalStream.on('error', () => cleanupSession(socket));

		// Pipe client input to the container
		socket.on('terminal:input', inputHandler);
		socket.on('terminal:resize', resizeHandler);
		// Client terminated the connection
		socket.on('terminal:disconnect', disconnectHandler);
		socket.on('disconnect', socketDisconnectHandler);

		socket.emit('terminal:connected');
	} catch (error) {
		console.error(error);
		cleanupSession(socket);
		socket.emit('terminal:error', 'Failed to start container terminal stream.');
	}
};

const findContainerShell = async (id) => {
	const commonShells = ['bash', 'sh', 'zsh', 'ash', 'dash'];
	for (const shell of commonShells) {
		try {
			await execa('docker', ['exec', id, shell, '-c', 'exit 0'], { stdio: 'ignore' });
			return shell;
		} catch (error) {
			continue;
		}
	}
	return null;
};

const onConnection = (socket, module) => {
	socket.on('terminal:connect', (containerId) => { 
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}
		
		terminalConnect(socket, containerId); 
	});
};

module.exports = {
	name: 'terminal',
	onConnection
};
