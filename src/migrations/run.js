(async () => {
	console.log(`Post install running...`);
	try {
		const { default: moveComposeFiles } = await import('./001_move_compose_files.js');
		await moveComposeFiles();

		const { default: renameBookmarksToShortcuts } = await import('./002_rename_bookmarks_to_shortcuts.js');
		await renameBookmarksToShortcuts();

		const { default: updateNotificationConfiguration } = await import('./001_update_notification_configuration_files.js');
		await updateNotificationConfiguration();

		const { default: removeIndexerConfiguration } = await import('./004_remove_indexer_configuration.js');
		await removeIndexerConfiguration();

		const { default: addApplicationCanEmbed } = await import('./005_add_application_can_embed.js');
		await addApplicationCanEmbed();

		const { default: addSampleArc } = await import('./006_add_sample_arc.js');
		await addSampleArc();

		const { default: addApplicationStoppedServices } = await import('./007_add_application_stopped_services.js');
		await addApplicationStoppedServices();

		console.log(`Post install completed successfully!`);
	} catch (error) {
		console.error(`Post install failed:`, error);
	}
})();
