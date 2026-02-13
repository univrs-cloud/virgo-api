(async () => {
	console.log(`Post install running...`);
	try {
		// await require('./000_configure_zram')();
		// await require('./001_move_database_location')();
		// await require('./005_rename_configuration_order_table')(); // must run before migrate configuration and data
		// await require('./002_migrate_configuration')();
		// await require('./003_migrate_data')();
		await require('./004_update_notification_configuration_files')();
		// await require('./006_copy_icons_to_config')();

		console.log(`Post install completed successfully!`);
	} catch (error) {
		console.error(`Post install failed:`, error);
	}
})();
