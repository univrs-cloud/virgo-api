const fs = require('fs');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const touch = require('touch');

let nsp;
let state = {};
const configurationFile = '/var/www/virgo-api/configuration.json';
const msmtpConfigurationFile = '/etc/msmtprc';
const zedConfigurationFile = '/etc/zfs/zed.d/zed.rc';

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

	if (!config?.recipients) {
		config.recipients = [];
	}
	if (config.recipients.length === 0) {
		config.recipients.push('voyager@univrs.cloud');
	}

	state.configuration.smtp = config;
	fs.writeFileSync(configurationFile, JSON.stringify(state.configuration, null, 2), 'utf8', { flag: 'w' });
	nsp.emit('configuration', state.configuration);

	fs.writeFileSync(msmtpConfigurationFile, generateMsmtpConfig(config), 'utf8', { flag: 'w' });
	fs.writeFileSync(zedConfigurationFile, generateZedConfig(config), 'utf8', { flag: 'w' });
	exec('systemctl restart zfs-zed');

	function generateMsmtpConfig(config) {
		return `defaults
${(config.username && config.password ? 'auth on' : 'auth off')}
tls on
tls_certcheck off
${(config.encryption === 'ssl' ? 'ssl-verify off' : '')}

account alerts
host ${config.address}
port ${config.port}
${(config.username && config.password ? `user ${config.username}\npassword ${config.password}` : '')}
from ${config.sender}

account default : alerts\n`;
	}

	function generateZedConfig(config) {
		return `ZED_EMAIL_ADDR="${config.recipients.join(' ')}"
ZED_EMAIL_PROG="mail"
ZED_EMAIL_OPTS="-s '@SUBJECT@' @ADDRESS@ "
ZED_NOTIFY_INTERVAL_SECS=3600
ZED_NOTIFY_VERBOSE=1
ZED_SYSLOG_SUBCLASS_EXCLUDE="history_event"\n`;
	}
};

const getConfiguration = (socket) => {
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
	if (socket.isAuthenticated) {
		nsp.emit('configuration', state.configuration);
	}
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
			if (socket.isAuthenticated) {
				nsp.emit('configuration', state.configuration);
			}
		} else {
			getConfiguration(socket);
		}

		socket.on('location', (config) => { setLocation(socket, config); });
		
		socket.on('smtp', (config) => { setSmtp(socket, config); });

		socket.on('disconnect', () => {
			//
		});
	});
};
