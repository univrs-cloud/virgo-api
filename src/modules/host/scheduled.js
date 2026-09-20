const register = (module) => {
	module.generateUpdates();
	
	// Schedule updates checker to run daily at midnight
	module.addJobSchedule(
		'host:updates:check',
		{ pattern: '0 0 0 * * *' }
	);

	module.addJobSchedule(
		'host:storage:refresh',
		{ pattern: '0 */5 * * * *' }
	);
};

export default {
	name: 'scheduled',
	register,
	jobs: {
		'host:updates:check': async (job, module) => {
			module.generateUpdates();
			return ``;
		},
		'host:storage:refresh': async (job, module) => {
			if (module.getPoller('storage')?.isRunning) {
				return ``;
			}

			await module.getPlugin('polling')?.refreshStorage(module);
			return ``;
		}
	}
};
