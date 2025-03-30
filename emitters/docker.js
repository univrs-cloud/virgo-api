const fs = require('fs');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const touch = require('touch');
const axios = require('axios');
const camelcaseKeys = require('camelcase-keys').default;
const si = require('systeminformation');
const dockerode = require('dockerode');

let nsp;
let state = {};
let actionStates = [];
let dataFileWatcher = null;
const docker = new dockerode();
const allowedActions = ['start', 'stop', 'kill', 'restart', 'remove'];
const dataFile = '/var/www/virgo-api/data.json';

const watchData = (socket) => {
	if (dataFileWatcher !== null) {
		return;
	}

	touch.sync(dataFile);

	if (state.configured === undefined) {
		state.configured = {};
		readData();
	}

	dataFileWatcher = fs.watch(dataFile, (eventType) => {
		if (eventType === 'change') {
			readData();
		}
	});

	function readData() {
		let data = fs.readFileSync(dataFile, { encoding: 'utf8', flag: 'r' });
		data = data.trim();
		if (data !== '') {
			state.configured = JSON.parse(data);
			nsp.emit('configured', state.configured);
		}
	};
}

const pollContainers = (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.containers;
		return;
	}

	docker.listContainers({ all: true })
		.then((containers) => {
			state.containers = camelcaseKeys(containers, { deep: true });
		})
		.catch((error) => {
			console.log(error);
			state.containers = false;
		})
		.then(() => {
			nsp.emit('containers', state.containers);
			setTimeout(pollContainers.bind(null, socket), 2000);
		});
};

const pollTemplates = (socket) => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.templates;
		return;
	}

	if (!socket.isAuthenticated) {
		return;
	}

	state.templates = [];

	Promise.all([
		axios.get('https://apps.univrs.cloud/template.json'),
		si.dockerContainers(true)
	])
		.then(([responseTemplate, dockerContainers]) => {
			state.templates = responseTemplate.data.templates.map((template) => {
				let dockerContainer = dockerContainers.find((container) => {
					return container.name.includes(template.name);
				});
				template.isInstalled = (dockerContainer !== undefined);
				return template;
			});
		})
		.catch((error) => {
			state.templates = false;
		})
		.then(() => {
			nsp.to(`user:${socket.user}`).emit('templates', state.templates);
			setTimeout(pollTemplates.bind(null, socket), 3600000);
		});
};

const install = (socket, config) => {
	if (!socket.isAuthenticated) {
		return;
	}

	console.log('install', config);
};

const performAction = (socket, config) => {
	if (!socket.isAuthenticated) {
		return;
	}

	if (!allowedActions.includes(config?.action)) {
		return;
	}

	actionStates.push(config);
	nsp.emit('actionStates', actionStates);

	if (config?.composeProject !== '') {
		exec(`docker compose -p ${config.composeProject} ${config.action}`)
			.then(() => {
				callback();
			});
		return;
	}

	const container = docker.getContainer(config?.id);
	container[config.action]()
		.then(() => {
			callback();
		});

	function callback() {
		actionStates = actionStates.filter((actionState) => {
			return actionState.id !== config.id;
		});
		nsp.emit('actionStates', actionStates);
	}
};

const terminalConnect = (socket, id) => {
	if (!socket.isAuthenticated) {
		return;
	}

	const container = docker.getContainer(id);
	if (!container) {
		return;
	}

	let shell = findContainerShell(id);

	container.exec(
		{
			Cmd: [`/bin/${shell}`],
			AttachStdin: true,
			AttachStdout: true,
			AttachStderr: true,
			Tty: true
		}
	)
		.then((exec) => {
			return exec.start(
				{
					stream: true,
					stdin: true,
					stdout: true,
					stderr: true,
					hijack: true
				}
			);
		})
		.then((stream) => {
			// Pipe container output to the client
			// Create readable streams for stdout and stderr
			const stdout = new require('stream').PassThrough();
    		const stderr = new require('stream').PassThrough();
			docker.modem.demuxStream(stream, stdout, stderr);
			stdout.on('data', (data) => { socket.emit('terminalOutput', data.toString('utf8')) });
    		stderr.on('data', (data) => { socket.emit('terminalOutput', data.toString('utf8')) });
			// Pipe client input to the container
			socket.on('terminalInput', (data) => {
				stream.write(data);
			});
			// Client terminated the connection
			socket.on('terminalDisconnect', () => {
				stream.destroy();
			});
			socket.on('disconnect', () => {
				stream.destroy();
			});
			socket.emit('terminalConnected');
		})
		.catch((error) => {
			console.error(error);
			socket.emit('terminalError', 'Failed to start container exec.');
		});

	function findContainerShell(id) {
		const commonShells = ['bash', 'sh', 'zsh', 'ash', 'dash'];
		for (const shell of commonShells) {
			try {
				childProcess.execSync(`docker exec ${id} ${shell} -c 'exit 0'`, { stdio: 'ignore' });
				return shell;
			} catch (error) {
				continue;
			}
		}
		return null;
	}
};

module.exports = (io) => {
	nsp = io.of('/docker');
	nsp.use((socket, next) => {
		socket.isAuthenticated = (socket.handshake.headers['remote-user'] !== undefined);
		socket.user = (socket.isAuthenticated ? socket.handshake.headers['remote-user'] : 'guest');
		next();
	});
	nsp.on('connection', (socket) => {
		socket.join(`user:${socket.user}`);

		watchData(socket);

		if (state.configured) {
			nsp.emit('configured', state.configured);
		}
		if (state.containers) {
			nsp.emit('containers', state.containers);
		} else {
			pollContainers(socket);
		}
		if (state.templates) {
			if (socket.isAuthenticated) {
				nsp.to(`user:${socket.user}`).emit('templates', state.templates);
			}
		} else {
			pollTemplates(socket);
		}

		socket.on('install', (config) => { install(socket, config); });
		socket.on('performAction', (config) => { performAction(socket, config); });
		socket.on('terminalConnect', (id) => { terminalConnect(socket, id); });

		socket.on('disconnect', () => {
			//
		});
	});
};
