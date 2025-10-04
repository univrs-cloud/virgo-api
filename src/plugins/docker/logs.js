const stream = require('stream');
const dockerode = require('dockerode');

const docker = new dockerode();

const logsConnect = async (socket, id, plugin) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	try {
		const container = docker.getContainer(id);
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
		stdout.on('data', (data) => { plugin.getNsp().to(`user:${socket.username}`).emit('logs:output', data.toString('utf8')) });
		stderr.on('data', (data) => { plugin.getNsp().to(`user:${socket.username}`).emit('logs:output', data.toString('utf8')) });
		docker.modem.demuxStream(logsStream, stdout, stderr);
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
};

module.exports = {
	name: 'logs',
	onConnection(socket, plugin) {
		socket.on('logs:connect', (id) => { 
			logsConnect(socket, id, plugin); 
		});
	}
};
