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
tls_starttls ${(config.encryption === 'ssl' ? 'off' : 'on' )}
tls_certcheck off

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
ZED_NOTIFY_DATA=1
ZED_SYSLOG_SUBCLASS_EXCLUDE="history_event"
`;
};

const generateAptListchangesConfig = (config) => {
	return `[apt]
frontend=log
which=both
email_address="${config.recipients.join(' ')}"
email_format=html
confirm=false
headers=false
reverse=false
save_seen=/var/lib/apt/listchanges
no_network=true
`;
}

const updateSmtpConfiguration = async (job, module) => {
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
	return `Notification server saved.`;
};

const updateNotificationConfigurationFiles = async () => {
	const configuration = await DataService.getConfiguration();
	if (configuration.smtp === null) {
		return;
	}
	
	await fs.promises.writeFile(msmtpConfigurationFile, generateMsmtpConfig(configuration.smtp), 'utf8');
	await fs.promises.writeFile(zedConfigurationFile, generateZedConfig(configuration.smtp), 'utf8');
	await fs.promises.writeFile(aptListchangesConfigurationFile, generateAptListchangesConfig(configuration.smtp), 'utf8');
	await execa('systemctl', ['restart', 'zfs-zed'], { reject: false });
};

const register = (module) => {
	module.eventEmitter
		.on('configuration:updated', updateNotificationConfigurationFiles);
};

const onConnection = (socket, module) => {
	socket.on('configuration:smtp:update', async (config) => {
		if (!socket.isAuthenticated || !socket.isAdmin) {
			return;
		}

		await module.addJob('smtp:update', { config, username: socket.username });
	});
};

module.exports = {
	register,
	onConnection,
	updateNotificationConfigurationFiles,
	jobs: {
		'smtp:update': updateSmtpConfiguration
	}
};
