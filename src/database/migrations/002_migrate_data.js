const fs = require('fs');
const DataService = require('../data_service');

const migrateData = async () => {
	const jsonDataPath = '/var/www/virgo-api/data.json';
	
	try {
		// Check if JSON file exists
		try {
			await fs.promises.access(jsonDataPath);
		} catch (error) {
			console.log('No data.json file found. Skipping data migration.');
			return;
		}
		
		console.log('Starting data migration from JSON to database...');
		
		// Initialize database (already done by configuration migration, but safe to call)
		await DataService.initialize();
		
		// Read JSON data
		const jsonData = await fs.promises.readFile(jsonDataPath, 'utf8');
		const data = JSON.parse(jsonData);
		
		// Migrate applications and bookmarks individually
		if (data.configuration && Array.isArray(data.configuration)) {
			for (const item of data.configuration) {
				if (item.type === 'app') {
					await DataService.setApplication(item);
					console.log(`Migrated app: ${item.name}`);
				} else if (item.type === 'bookmark') {
					await DataService.setBookmark(item);
					console.log(`Migrated bookmark: ${item.name}`);
				}
			}
		}
		
		console.log('Data migration completed successfully!');
		
		// Rename the original file to indicate it's been migrated
		await fs.promises.rename(jsonDataPath, `${jsonDataPath}.migrated`);
		console.log('Data file renamed to data.json.migrated');
		
	} catch (error) {
		console.error('Data migration failed:', error);
		throw error;
	} finally {
		await DataService.close();
	}
};

module.exports = migrateData;
