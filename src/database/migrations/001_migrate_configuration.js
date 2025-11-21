const fs = require('fs');
const DataService = require('../data_service');

const migrateConfiguration = async () => {
	const jsonConfigPath = '/var/www/virgo-api/configuration.json';
	
	try {
		// Check if JSON file exists
		try {
			await fs.promises.access(jsonConfigPath);
		} catch (error) {
			console.log(`No JSON configuration file found. Skipping migration.`);
			return;
		}
		
		console.log(`Starting migration from JSON to database...`);
		
		// Initialize database
		await DataService.initialize();
		
		// Read JSON configuration
		const jsonData = await fs.promises.readFile(jsonConfigPath, 'utf8');
		const configuration = JSON.parse(jsonData);
		
		// Migrate each configuration key to database
		for (const [key, value] of Object.entries(configuration)) {
			await DataService.setConfiguration(key, value);
			console.log(`Migrated ${key} to database`);
		}
		
		console.log(`Migration completed successfully!`);
		
		// Rename the original file to indicate it's been migrated
		await fs.promises.rename(jsonConfigPath, `${jsonConfigPath}.migrated`);
		console.log(`File renamed to configuration.json.migrated`);
		
	} catch (error) {
		console.error(`Migration failed:`, error);
	}
};

// Run if this file is executed directly
if (require.main === module) {
	migrateConfiguration();
}

module.exports = migrateConfiguration;
