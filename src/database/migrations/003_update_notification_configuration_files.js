import { updateNotificationConfigurationFiles } from '../../modules/configuration/smtp_update';

const updateNotificationConfiguration = async () => {
	await updateNotificationConfigurationFiles();
};

// Run if this file is executed directly
if (require.main === module) {
	updateNotificationConfiguration();
}

module.exports = updateNotificationConfiguration;
