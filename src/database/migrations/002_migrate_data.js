const fs = require('fs');
const DataService = require('../data_service');

const migrateData = async () => {
	const jsonDataPath = '/var/www/virgo-api/data.json';
	
	try {
		// Check if JSON file exists
		try {
			await fs.promises.access(jsonDataPath);
		} catch (error) {
			console.log(`No data.json file found. Skipping migration.`);
			return;
		}
		
		console.log(`Starting migration from JSON to database...`);
		
		// Initialize database (already done by configuration migration, but safe to call)
		await DataService.initialize();
		
		// Read JSON data
		const jsonData = await fs.promises.readFile(jsonDataPath, 'utf8');
		const data = JSON.parse(jsonData);
		
		// Migrate applications and bookmarks individually
		if (data.configuration && Array.isArray(data.configuration)) {
			// Group items by category and track order within each category
			const categoryGroups = {};
			
			// First pass: group items by category
			for (const item of data.configuration) {
				const category = item.category || 'Uncategorized';
				if (!categoryGroups[category]) {
					categoryGroups[category] = [];
				}
				categoryGroups[category].push(item);
			}
			
			// Second pass: migrate items and assign order within each category
			for (const [category, items] of Object.entries(categoryGroups)) {
				let order = 1;
				
				for (const item of items) {
					if (item.type === 'app') {
						// Remove order field from app data
						const { order: _, ...appData } = item;
						await DataService.setApplication(appData);
						
						// Set order in the ConfigurationOrder table
						const createdApp = await DataService.getApplication(item.name);
						if (createdApp) {
							await DataService.setConfigurationOrder(createdApp.id, 'app', order++);
							console.log(`Migrated app: ${item.name} (category: ${category}, order: ${order - 1})`);
						}
					} else if (item.type === 'bookmark') {
						// Remove order field from bookmark data
						const { order: _, ...bookmarkData } = item;
						await DataService.setBookmark(bookmarkData);
						
						// Set order in the ConfigurationOrder table
						const createdBookmark = await DataService.getBookmark(item.name);
						if (createdBookmark) {
							await DataService.setConfigurationOrder(createdBookmark.id, 'bookmark', order++);
							console.log(`Migrated bookmark: ${item.name} (category: ${category}, order: ${order - 1})`);
						}
					}
				}
			}
		}
		
		console.log(`Migration completed successfully!`);
		
		// Rename the original file to indicate it's been migrated
		await fs.promises.rename(jsonDataPath, `${jsonDataPath}.migrated`);
		console.log(`File renamed to data.json.migrated`);
		
	} catch (error) {
		console.error(`Migration failed:`, error);
	}
};

module.exports = migrateData;
