import { createLog } from '../utils/log.js';

const log = createLog('migrations');

(async () => {
	log.info(`Post install running...`);
	try {
		const { default: updateNotificationConfiguration } = await import('./000_update_notification_configuration_files.js');
		await updateNotificationConfiguration();

		log.info(`Post install completed successfully!`);
	} catch (error) {
		log.error(`Post install failed:`, error);
	}
})();
