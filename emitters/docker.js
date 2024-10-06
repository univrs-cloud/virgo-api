const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);
const path = require('path');
const axios = require('axios');
const si = require('systeminformation');
const dockerode = require('dockerode');

const docker = new dockerode();
let isAuthenticated = false;
let user;
let nsp;
let state = {};
let actionStates = [];

const pollConfigured = () => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.configured;
		return;
	}

	Promise.all([
		fs.promises.readFile(path.join(__dirname,'../../data.json'), 'utf8'),
		si.dockerContainers(true)
	])
		.then(([responseData, dockerContainers]) => {
			let configured = JSON.parse(responseData);
			configured.containers = dockerContainers;
			state.configured = configured;
		})
		.catch((error) => {
			state.configured = false;
		})
		.then(() => {
			nsp.emit('configured', state.configured);
			setTimeout(pollConfigured, 2000);
		});
};

const pollTemplates = () => {
	if (nsp.server.engine.clientsCount === 0) {
		delete state.templates;
		return;
	}

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
			nsp.emit('templates', state.templates);
			setTimeout(pollTemplates, 3600000);
		});
};

const install = (config) => {
	console.log('install', config);
};

const performAction = (config) => {
	if (!isAuthenticated) {
		nsp.to(`user:${user}`).emit('actionStates', false);
		return;
	}
	
	actionStates.push(config);
	nsp.emit('actionStates', actionStates);
	
	let container = docker.getContainer(config.id);
	container.inspect((error, data) => {
		let composeProject = data.Config.Labels['com.docker.compose.project'];
		if (composeProject) {
			exec(`docker compose -p ${composeProject} ${config.action}`)
				.then(() => {
					cb();
				})
				.catch((error) => {
					console.log(error);
				});
			return;
		}

		container[config.action]((error, data) => {
			cb();
			if (error !== null) {
				console.log(error);
			}
		});
	});

	function cb() {
		actionStates = actionStates.filter((actionState) => {
			return actionState.id !== config.id;
		});
		nsp.emit('actionStates', actionStates);
	}
};

module.exports = (io) => {
	nsp = io.of('/docker').on('connection', (socket) => {
		isAuthenticated = socket.handshake.headers['remote-user'] !== undefined;
		user = (isAuthenticated ? socket.handshake.headers['remote-user'] : 'unautorized');
		socket.join(`user:${user}`);
		if (state.configured) {
			nsp.emit('configured', state.configured);
		} else {
			pollConfigured();
		}
		if (state.templates) {
			nsp.emit('templates', state.templates);
		} else {
			pollTemplates();
		}

		socket.on('install', install);

		socket.on('performAction', performAction);

		socket.on('disconnect', () => {
			//
		});
	});
};
