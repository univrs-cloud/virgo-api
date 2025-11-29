const DataService = require('../database/data_service');
const { updateNotificationConfigurationFiles } = require('../modules/configuration/smtp_update');

const updateNotificationConfiguration = async () => {
	try {
		// Initialize database
		await DataService.initialize();

		await updateNotificationConfigurationFiles();

		console.log(`Notification configuration updated successfully!`);
	} catch (error) {
		console.error(`Notification configuration update failed:`, error);
	}
};

// Run if this file is executed directly
if (require.main === module) {
	updateNotificationConfiguration();
}

module.exports = updateNotificationConfiguration;
