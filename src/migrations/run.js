console.log(`Running migrations...`);
try {
	await require('./000_setup')();
	await require('./001_move_database_location')();
	await require('./002_migrate_configuration')();
	await require('./003_migrate_data')();
	await require('./004_update_notification_configuration_files')();
	
	console.log(`All migrations completed successfully!`);
} catch (error) {
	console.error(`Migration failed:`, error);
	throw error;
}
