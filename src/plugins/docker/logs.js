const stream = require('stream');
const dockerode = require('dockerode');

const docker = new dockerode();

async function logsConnect(socket, id, plugin) {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	const container = docker.getContainer(id);
	if (!container) {
		return;
	}

	try {
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
		docker.modem.demuxStream(logsStream, stdout, stderr);
		stdout.on('data', (data) => { plugin.getNsp().to(`user:${socket.username}`).emit('logs:output', data.toString('utf8')) });
		stderr.on('data', (data) => { plugin.getNsp().to(`user:${socket.username}`).emit('logs:output', data.toString('utf8')) });
		// Client terminated the connection
		socket.on('logs:disconnect', () => {
			logsStream.destroy();
		});
		socket.on('disconnect', () => {
			logsStream.destroy();
		});
		plugin.getNsp().to(`user:${socket.username}`).emit('logs:connected');
	} catch (error) {
		plugin.getNsp().to(`user:${socket.username}`).emit('logs:error', 'Failed to start container logs stream.');
	}
}

module.exports = {
	onConnection(socket, plugin) {
		socket.on('logs:connect', (id) => { 
			logsConnect(socket, id, plugin); 
		});
	}
};
