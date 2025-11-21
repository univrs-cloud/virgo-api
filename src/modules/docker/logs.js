const stream = require('stream');
const dockerode = require('dockerode');

const docker = new dockerode();

const logsConnect = async (socket, containerId) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	try {
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
		// Pipe container output to the client
		// Create readable streams for stdout and stderr
		const stdout = new stream.PassThrough();
		const stderr = new stream.PassThrough();
		stdout.on('data', (data) => { socket.emit('logs:output', data.toString('utf8')) });
		stderr.on('data', (data) => { socket.emit('logs:output', data.toString('utf8')) });
		docker.modem.demuxStream(logsStream, stdout, stderr);
		// Client terminated the connection
		socket.on('logs:disconnect', () => {
			logsStream.destroy();
		});
		socket.on('disconnect', () => {
			logsStream.destroy();
		});
		socket.emit('logs:connected');
	} catch (error) {
		socket.emit('logs:error', 'Failed to start container logs stream.');
	}
};

const onConnection = (socket, module) => {
	socket.on('logs:connect', (containerId) => { 
		logsConnect(socket, containerId); 
	});
};

module.exports = {
	name: 'logs',
	onConnection
};
