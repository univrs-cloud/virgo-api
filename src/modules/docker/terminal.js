const { execa } = require('execa');
const stream = require('stream');
const dockerode = require('dockerode');

const docker = new dockerode();

const terminalConnect = async (socket, containerId) => {
	if (!socket.isAuthenticated || !socket.isAdmin) {
		return;
	}

	try {
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
		// Pipe container output to the client
		// Create readable streams for stdout and stderr
		const stdout = new stream.PassThrough();
		const stderr = new stream.PassThrough();
		stdout.on('data', (data) => { socket.emit('terminal:output', data.toString('utf8')) });
		stderr.on('data', (data) => { socket.emit('terminal:output', data.toString('utf8')) });
		docker.modem.demuxStream(terminalStream, stdout, stderr);
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
		socket.emit('terminal:connected');
	} catch (error) {
		console.error(error);
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

module.exports = {
	name: 'terminal',
	onConnection(socket, module) {
		socket.on('terminal:connect', (containerId) => { 
			terminalConnect(socket, containerId); 
		});
	}
};
