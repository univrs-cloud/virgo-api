const util = require('util');
const exec = util.promisify(require('child_process').exec);
const stream = require('stream');
const dockerode = require('dockerode');

const docker = new dockerode();

async function terminalConnect(socket, id, plugin) {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	const container = docker.getContainer(id);
	if (!container) {
		return;
	}

	let shell = await findContainerShell(id);
	if (!shell) {
		plugin.getNsp().to(`user:${socket.username}`).emit('terminal:error', 'No compatible shell found in container.');
		return;
	}

	try {
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
		// Pipe container output to the client
		// Create readable streams for stdout and stderr
		const stdout = new stream.PassThrough();
		const stderr = new stream.PassThrough();
		docker.modem.demuxStream(terminalStream, stdout, stderr);
		stdout.on('data', (data) => { plugin.getNsp().to(`user:${socket.username}`).emit('terminal:output', data.toString('utf8')) });
		stderr.on('data', (data) => { plugin.getNsp().to(`user:${socket.username}`).emit('terminal:output', data.toString('utf8')) });
		// Pipe client input to the container
		socket.on('terminal:input', (data) => {
			terminalStream.write(data);
		});
		socket.on('terminal:resize', (size) => {
			containerExec.resize({
				h: size.rows,
				w: size.cols
			});
		});
		// Client terminated the connection
		socket.on('terminal:disconnect', () => {
			terminalStream.destroy();
		});
		socket.on('disconnect', () => {
			terminalStream.destroy();
		});
		plugin.getNsp().to(`user:${socket.username}`).emit('terminal:connected');
	} catch (error) {
		console.error(error);
		plugin.getNsp().to(`user:${socket.username}`).emit('terminal:error', 'Failed to start container terminal stream.');
	}

	async function findContainerShell(id) {
		const commonShells = ['bash', 'sh', 'zsh', 'ash', 'dash'];
		for (const shell of commonShells) {
			try {
				await exec('docker', ['exec', id, shell, `-c 'exit 0'`], { stdio: 'ignore' });
				return shell;
			} catch (error) {
				continue;
			}
		}
		return null;
	}
}

module.exports = {
	name: 'terminal',
	onConnection(socket, plugin) {
		socket.on('terminal:connect', (id) => { 
			terminalConnect(socket, id, plugin); 
		});
	}
};
