const fs = require('fs');
const path = require('path');
const axios = require('axios');
const si = require('systeminformation');

let nsp;
let state = {};

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
		axios.get('https://raw.githubusercontent.com/univrs-cloud/virgo-apps/main/template.json'),
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
	console.log('performAction', config);
};

module.exports = (io) => {
	nsp = io.of('/docker').on('connection', (socket) => {
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
