const runMigrations = async () => {
	try {
		console.log(`Running database migrations...`);
		
		// Run migrations in order
		await require('./000_move_database_location')();
		await require('./001_migrate_configuration')();
		await require('./002_migrate_data')();
		await require('./003_update_notification_configuration_files')();
		
		console.log(`All migrations completed successfully!`);
	} catch (error) {
		console.error(`Migration failed:`, error);
		throw error;
	}
};

module.exports = {
	runMigrations
};
