(async () => {
	console.log(`Post install running...`);
	try {
		await require('./001_update_notification_configuration_files')();

		console.log(`Post install completed successfully!`);
	} catch (error) {
		console.error(`Post install failed:`, error);
	}
})();
