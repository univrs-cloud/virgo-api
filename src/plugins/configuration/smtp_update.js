const fs = require('fs');
const { execa } = require('execa');
const DataService = require('../../database/data_service');

const msmtpConfigurationFile = '/etc/msmtprc';
const zedConfigurationFile = '/etc/zfs/zed.d/zed.rc';

const updateSmtp = async (job, plugin) => {
	let config = job.data.config;
	await plugin.updateJobProgress(job, `Saving notification server...`);
	
	if (!config?.recipients) {
		config.recipients = [];
	}
	if (config.recipients.length === 0) {
		config.recipients.push('voyager@univrs.cloud');
	}

	await DataService.setConfiguration('smtp', config);
	plugin.getInternalEmitter().emit('configuration:updated');
	await plugin.broadcastConfiguration();
	
	await fs.promises.writeFile(msmtpConfigurationFile, generateMsmtpConfig(config), 'utf8');
	await fs.promises.writeFile(zedConfigurationFile, generateZedConfig(config), 'utf8');
	await execa('systemctl', ['restart', 'zfs-zed']);
	
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

account default : alerts
`;
	}

	function generateZedConfig(config) {
		return `ZED_EMAIL_ADDR="${config.recipients.join(' ')}"
ZED_EMAIL_PROG="mail"
ZED_EMAIL_OPTS="-s '@SUBJECT@' @ADDRESS@ "
ZED_NOTIFY_INTERVAL_SECS=3600
ZED_NOTIFY_VERBOSE=1
ZED_SYSLOG_SUBCLASS_EXCLUDE="history_event"
`;
	}
};

module.exports = {
	onConnection(socket, plugin) {
		socket.on('configuration:smtp:update', async (config) => {
			await plugin.addJob('smtp:update', { config, username: socket.username });
		});
	},
	jobs: {
		'smtp:update': updateSmtp
	}
};
