(async () => {
	console.log(`Post install running...`);
	try {
		const { default: renameBookmarksToShortcuts } = await import('./002_rename_bookmarks_to_shortcuts.js');
		await renameBookmarksToShortcuts();

		const { default: updateNotificationConfiguration } = await import('./001_update_notification_configuration_files.js');
		await updateNotificationConfiguration();

		console.log(`Post install completed successfully!`);
	} catch (error) {
		console.error(`Post install failed:`, error);
	}
})();
