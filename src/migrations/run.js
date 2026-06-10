(async () => {
	console.log(`Post install running...`);
	try {
		const { default: updateNotificationConfiguration } = await import('./001_update_notification_configuration_files.js');
		await updateNotificationConfiguration();

		console.log(`Post install completed successfully!`);
	} catch (error) {
		console.error(`Post install failed:`, error);
	}
})();
