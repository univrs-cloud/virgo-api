const fs = require('fs');
const touch = require('touch');

let nsp;
let state = {};
let configurationFile = '/var/www/virgo-api/configuration.json';

const setLocation = (socket, config) => {
	if (!socket.isAuthenticated) {
		return;
	}

	state.configuration.location = config;
	fs.writeFileSync(configurationFile, JSON.stringify(state.configuration, null, 2), 'utf8', { flag: 'w' });
	nsp.emit('configuration', state.configuration);
};

const setSmtp = (socket, config) => {
	if (!socket.isAuthenticated) {
		return;
	}

	state.configuration.smtp = config;
	fs.writeFileSync(configurationFile, JSON.stringify(state.configuration, null, 2), 'utf8', { flag: 'w' });
	nsp.emit('configuration', state.configuration);
};

const getConfiguration = () => {
	touch.sync(configurationFile);
	let configuration = fs.readFileSync(configurationFile, { encoding: 'utf8', flag: 'r' });
	configuration = configuration.trim();
	if (configuration === '') {
		configuration = {
			location: {
				latitude: '45.749',
				longitude: '21.227'
			},
			smtp: null
		};
	} else {
		configuration = JSON.parse(configuration);
	}
	state.configuration = configuration;
	nsp.emit('configuration', state.configuration);
};

module.exports = (io) => {
	nsp = io.of('/configuration');
	nsp.use((socket, next) => {
		socket.isAuthenticated = (socket.handshake.headers['remote-user'] !== undefined);
		socket.user = (socket.isAuthenticated ? socket.handshake.headers['remote-user'] : 'guest');
		next();
	});
	nsp.on('connection', (socket) => {
		socket.join(`user:${socket.user}`);

		if (state.configuration) {
			nsp.emit('configuration', state.configuration);
		} else {
			getConfiguration();
		}

		socket.on('location', (config) => { setLocation(socket, config); });
		
		socket.on('smtp', (config) => { setSmtp(socket, config); });

		socket.on('disconnect', () => {
			//
		});
	});
};
