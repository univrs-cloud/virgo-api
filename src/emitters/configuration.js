const fs = require('fs');
const util = require('util');
const childProcess = require('child_process');
const exec = util.promisify(childProcess.exec);
const touch = require('touch');
const BaseEmitter = require('./base');
const FileWatcher = require('../utils/file_watcher');

class ConfigurationEmitter extends BaseEmitter {
	#configurationWatcher;
	#configurationFile = '/var/www/virgo-api/configuration.json';
	#msmtpConfigurationFile = '/etc/msmtprc';
	#zedConfigurationFile = '/etc/zfs/zed.d/zed.rc';

	constructor(io) {
		super(io, 'configuration');
		this.#watchConfiguration();
	}

	onConnection(socket) {
		if (this.getState('configuration') !== undefined) {
			let configuration = { ...this.getState('configuration') };
			if (!socket.isAuthenticated || !socket.isAdmin) {
				delete configuration.smtp;
			}
			this.getNsp().to(`user:${socket.username}`).emit('configuration', configuration);
		}

		socket.on('location', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}
			
			await this.addJob('setLocation', { config, username: socket.username });
		});

		socket.on('smtp', async (config) => {
			if (!socket.isAuthenticated || !socket.isAdmin) {
				return;
			}

			await this.addJob('setSmtp', { config, username: socket.username });
		});
	}

	async processJob(job) {
		if (job.name === 'setSmtp') {
			return await this.#setSmtp(job);
		}
		if (job.name === 'setLocation') {
			return await this.#setLocation(job);
		}
	}

	#watchConfiguration() {
		const readFile = () => {
			let data = fs.readFileSync(this.#configurationFile, { encoding: 'utf8', flag: 'r' });
			data = data.trim();
			if (data === '') {
				this.setState('configuration', {
					location: {
						latitude: '45.749',
						longitude: '21.227'
					},
					smtp: null
				});
			} else {
				this.setState('configuration', JSON.parse(data));
			}
			let configuration = { ...this.getState('configuration') };
			for (const socket of this.getNsp().sockets.values()) {
				if (!socket.isAuthenticated || !socket.isAdmin) {
					delete configuration.smtp;
				}
				this.getNsp().to(`user:${socket.username}`).emit('configuration', configuration);
			};
		};
		
		if (this.#configurationWatcher) {
			return;
		}
	
		if (!fs.existsSync(this.#configurationFile)) {
			touch.sync(this.#configurationFile);
		}
	
		if (this.getState('configuration') === undefined) {
			this.setState('configuration', {});
			readFile();
		}
	
		this.#configurationWatcher = new FileWatcher(this.#configurationFile);
		this.#configurationWatcher
			.onChange((event, path) => {
				readFile();
			});
	}

	#setLocation = async (job) => {
		let config = job.data.config;
		await this.updateJobProgress(job, `Saving location...`);
		let configuration = this.getState('configuration');
		configuration.location = config;
		fs.writeFileSync(this.#configurationFile, JSON.stringify(configuration, null, 2), 'utf8', { flag: 'w' });
		this.setState('configuration', configuration);
		return `Location saved.`;
	}

	#setSmtp = async (job) => {
		let config = job.data.config;
		await this.updateJobProgress(job, `Saving sotification server...`);
		if (!config?.recipients) {
			config.recipients = [];
		}
		if (config.recipients.length === 0) {
			config.recipients.push('voyager@univrs.cloud');
		}
	
		let configuration = this.getState('configuration');
		configuration.smtp = config;
		fs.writeFileSync(this.#configurationFile, JSON.stringify(configuration, null, 2), 'utf8', { flag: 'w' });
		this.setState('configuration', configuration);
		fs.writeFileSync(this.#msmtpConfigurationFile, generateMsmtpConfig(config), 'utf8', { flag: 'w' });
		fs.writeFileSync(this.#zedConfigurationFile, generateZedConfig(config), 'utf8', { flag: 'w' });
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
	}
}

module.exports = (io) => {
	return new ConfigurationEmitter(io);
};
