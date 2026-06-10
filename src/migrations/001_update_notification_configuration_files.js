import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import DataService from '../database/data_service.js';
import smtp from '../modules/configuration/smtp.js';

const { updateNotificationConfigurationFiles } = smtp;
const isMainModule = path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

const DB_PATHS = ['/messier/.config/virgo.db', '/var/www/virgo-api/virgo.db'];

const databaseExists = async () => {
	for (const dbPath of DB_PATHS) {
		try {
			await fs.access(dbPath);
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

if (isMainModule) {
	updateNotificationConfiguration();
}

export default updateNotificationConfiguration;
