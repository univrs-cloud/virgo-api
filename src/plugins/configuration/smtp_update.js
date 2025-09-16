const fs = require('fs');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

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

	let configuration = plugin.getState('configuration');
	configuration.smtp = config;
	fs.writeFileSync(plugin.configurationFile, JSON.stringify(configuration, null, 2), 'utf8', { flag: 'w' });
	plugin.setState('configuration', configuration);
	
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
