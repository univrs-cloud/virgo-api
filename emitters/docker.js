const fs = require('fs');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const touch = require('touch');
const axios = require('axios');
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

	si.dockerContainers(true)
		.then((containers) => {
			state.containers = containers;
		})
		.catch((error) => {
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

	let container = docker.getContainer(config?.id);
	if (!container) {
		return; 
	}

	actionStates.push(config);
	nsp.emit('actionStates', actionStates);

	container.inspect((error, data) => {
		let composeProject = data.Config.Labels['com.docker.compose.project'];
		if (composeProject) {
			exec(`docker compose -p ${composeProject} ${config.action}`)
				.then(() => {
					callback();
				})
				.catch((error) => {
					console.log(error);
				});
			return;
		}

		container[config.action]((error, data) => {
			callback();
			if (error !== null) {
				console.log(error);
			}
		});
	});

	function callback() {
		actionStates = actionStates.filter((actionState) => {
			return actionState.id !== config.id;
		});
		nsp.emit('actionStates', actionStates);
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

		socket.on('disconnect', () => {
			//
		});
	});
};
