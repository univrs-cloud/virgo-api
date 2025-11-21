const fs = require('fs');
const { execa } = require('execa');
const DataService = require('../../database/data_service');

const msmtpConfigurationFile = '/etc/msmtprc';
const zedConfigurationFile = '/etc/zfs/zed.d/zed.rc';
const aptListchangesConfigurationFile = '/etc/apt/listchanges.conf';

const generateMsmtpConfig = (config) => {
	return `defaults
${(config.username && config.password ? 'auth on' : 'auth off')}
tls on
tls_starttls ${(parseInt(config.port) === 465 ? 'off' : 'on' )}
tls_certcheck off
${(config.encryption === 'ssl' ? 'ssl-verify off' : '')}

account alerts
host ${config.address}
port ${config.port}
${(config.username && config.password ? `user ${config.username}\npassword ${config.password}` : '')}
from ${config.sender}

account default : alerts
`;
};

const generateZedConfig = (config) => {
	return `ZED_EMAIL_ADDR="${config.recipients.join(' ')}"
ZED_EMAIL_PROG="mail"
ZED_EMAIL_OPTS="-s '@SUBJECT@' @ADDRESS@ "
ZED_NOTIFY_INTERVAL_SECS=3600
ZED_NOTIFY_VERBOSE=1
ZED_SYSLOG_SUBCLASS_EXCLUDE="history_event"
`;
};

const generateAptListchangesConfig = (config) => {
	return `[apt]
frontend=mail
which=both
email_address="${config.recipients.join(' ')}"
email_format=html
confirm=false
headers=false
reverse=false
save_seen=/var/lib/apt/listchanges.db
`;
}

const updateSmtp = async (job, module) => {
	let config = job.data.config;
	await module.updateJobProgress(job, `Saving notification server...`);
	
	if (!config?.recipients) {
		config.recipients = [];
	}
	if (config.recipients.length === 0) {
		config.recipients.push('voyager@univrs.cloud');
	}

	await DataService.setConfiguration('smtp', config);
	module.eventEmitter.emit('configuration:updated');
	
	await fs.promises.writeFile(msmtpConfigurationFile, generateMsmtpConfig(config), 'utf8');
	await fs.promises.writeFile(zedConfigurationFile, generateZedConfig(config), 'utf8');
	await fs.promises.writeFile(aptListchangesConfigurationFile, generateAptListchangesConfig(config), 'utf8');
	await execa('systemctl', ['restart', 'zfs-zed']);
	return `Notification server saved.`;
};

module.exports = {
	onConnection(socket, module) {
		socket.on('configuration:smtp:update', async (config) => {
			await module.addJob('smtp:update', { config, username: socket.username });
		});
	},
	jobs: {
		'smtp:update': updateSmtp
	}
};
