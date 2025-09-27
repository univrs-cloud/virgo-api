const migrateConfiguration = require('./001_migrate_configuration');
const migrateData = require('./002_migrate_data');

const runMigrations = async () => {
	try {
		console.log('Running database migrations...');
		
		// Run migrations in order
		await migrateConfiguration();
		await migrateData();
		
		console.log('All migrations completed successfully!');
	} catch (error) {
		console.error('Migration failed:', error);
		throw error;
	}
};

module.exports = {
	runMigrations
};
