const fs = require('fs');
const DataService = require('../database/data_service');
const { updateNotificationConfigurationFiles } = require('../modules/configuration/smtp_update');

const DB_PATHS = ['/messier/.config/virgo.db', '/var/www/virgo-api/virgo.db'];

const databaseExists = async () => {
	for (const dbPath of DB_PATHS) {
		try {
			await fs.promises.access(dbPath);
			return true;
		} catch (_) {
			// continue
		}
	}
	return false;
};

const updateNotificationConfiguration = async () => {
	try {
		// Check if a database already exists; if not, skip
		if (!(await databaseExists())) {
			console.log(`No database file found. Skipping notification configuration update.`);
			return;
		}

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
