const fs = require('fs');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const touch = require('touch');
const { Queue, Worker } = require('bullmq');

let nsp;
let state = {};
let configurationFileWatcher = null;
const configurationFile = '/var/www/virgo-api/configuration.json';
const msmtpConfigurationFile = '/etc/msmtprc';
const zedConfigurationFile = '/etc/zfs/zed.d/zed.rc';
const queue = new Queue('configuration-jobs');
const worker = new Worker(
	'configuration-jobs',
	async (job) => {
		if (job.name === 'setSmtp') {
			return await setSmtp(job);
		}
		if (job.name === 'setLocation') {
			return await setLocation(job);
		}
	},
	{
		connection: {
			host: 'localhost',
			port: 6379,
		}
	}
);
worker.on('completed', async (job, result) => {
	if (job) {
		await updateProgress(job, result);
	}
});
worker.on('failed', async (job, error) => {
	if (job) {
		await updateProgress(job, ``);
	}
});
worker.on('error', (error) => {
	console.error(error);
});

const updateProgress = async (job, message) => {
	const state = await job.getState();
	await job.updateProgress({ state, message });
};

const watchConfiguration = async (socket) => {
	if (configurationFileWatcher !== null) {
		return;
	}

	touch.sync(configurationFile);

	if (state.configuration === undefined) {
		state.configuration = {};
		readFile();
	}

	configurationFileWatcher = fs.watch(configurationFile, (eventType) => {
		if (eventType === 'change') {
			readFile();
		}
	});

	function readFile() {
		let data = fs.readFileSync(configurationFile, { encoding: 'utf8', flag: 'r' });
		data = data.trim();
		if (data === '') {
			state.configuration = {
				location: {
					latitude: '45.749',
					longitude: '21.227'
				},
				smtp: null
			};
		} else {
			state.configuration = JSON.parse(data);
		}
		let configuration = { ...state.configuration };
		if (!socket.isAuthenticated) {
			delete configuration.smtp;
		}
		nsp.to(`user:${socket.user}`).emit('configuration', configuration);
	};
}

const setLocation = async (job) => {
	let config = job.data.config;
	await updateProgress(job, `Saving location...`);
	state.configuration.location = config;
	fs.writeFileSync(configurationFile, JSON.stringify(state.configuration, null, 2), 'utf8', { flag: 'w' });
	return `Location saved.`;
};

const setSmtp = async (job) => {
	let config = job.data.config;
	await updateProgress(job, `Saving sotification server...`);
	if (!config?.recipients) {
		config.recipients = [];
	}
	if (config.recipients.length === 0) {
		config.recipients.push('voyager@univrs.cloud');
	}

	state.configuration.smtp = config;
	fs.writeFileSync(configurationFile, JSON.stringify(state.configuration, null, 2), 'utf8', { flag: 'w' });
	fs.writeFileSync(msmtpConfigurationFile, generateMsmtpConfig(config), 'utf8', { flag: 'w' });
	fs.writeFileSync(zedConfigurationFile, generateZedConfig(config), 'utf8', { flag: 'w' });
	await exec('systemctl restart zfs-zed');
	return `Notification server saved.`;

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

module.exports = (io) => {
	nsp = io.of('/configuration');
	nsp.use((socket, next) => {
		socket.isAuthenticated = (socket.handshake.headers['remote-user'] !== undefined);
		socket.user = (socket.isAuthenticated ? socket.handshake.headers['remote-user'] : 'guest');
		next();
	});
	nsp.on('connection', (socket) => {
		socket.join(`user:${socket.user}`);

		watchConfiguration(socket);

		if (state.configuration) {
			let configuration = { ...state.configuration };
			if (!socket.isAuthenticated) {
				delete configuration.smtp;
			}
			nsp.to(`user:${socket.user}`).emit('configuration', configuration);
		}

		socket.on('location', async (config) => {
			if (socket.isAuthenticated) {
				try {
					await queue.add('setLocation', { config, user: socket.user });
				} catch (error) {
					console.error('Error starting job:', error);
				}
			}
		});

		socket.on('smtp', async (config) => {
			if (socket.isAuthenticated) {
			  try {
				await queue.add('setSmtp', { config, user: socket.user });
			  } catch (error) {
				console.error('Error starting job:', error);
			  }
			}
		  });

		socket.on('disconnect', () => {
			//
		});
	});
};
